/**
 * DuckDB for codemode: SQL over databases, files and rows the code fetched.
 *
 *   const { rows } = await duckdb.query({
 *     sql: "select status, count(*) n from orders group by status",
 *     tables: { orders },
 *   })
 *
 * A query runs on a database of its own, in memory, that is gone when the
 * query returns. `duckdb.open` makes one that lasts until the run ends, so
 * several queries see the same tables.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type DuckDBConnection,
  DuckDBInstance,
  DuckDBTypeId,
} from "@duckdb/node-api";
import type { ActionContext, CodemodePluginAPI } from "@shiftlabs/codemode";
import { packageVersion } from "@shiftlabs/codemode/utils/cli";
import * as t from "typebox";

const DEFAULT_MAX_ROWS = 10_000;

/** What DuckDB's client says of SQL with no statement in it. */
const NO_STATEMENT = "Error in native callback";

/** Integer types wider than a JavaScript number holds exactly. */
const WIDE_INTEGERS = new Set<DuckDBTypeId>([
  DuckDBTypeId.BIGINT,
  DuckDBTypeId.UBIGINT,
  DuckDBTypeId.HUGEINT,
  DuckDBTypeId.UHUGEINT,
]);

const scalar = t.Union([t.String(), t.Number(), t.Boolean(), t.Null()]);

const queryInput = t.Object(
  {
    sql: t.String({
      minLength: 1,
      description:
        "DuckDB SQL. Of several statements, all run and the last one's rows return.",
    }),
    params: t.Optional(
      t.Union([t.Array(scalar), t.Record(t.String(), scalar)], {
        description:
          "Values for the last statement's parameters: a list for `$1`, `$2`, or an object for `$name`. Pass values here instead of writing them into the SQL.",
      }),
    ),
    tables: t.Optional(
      t.Record(t.String(), t.Array(t.Record(t.String(), t.Unknown())), {
        description:
          "Rows to query, by table name: `{ orders: [{ id: 1 }, …] }`. Each becomes a temporary table whose column types DuckDB works out from the values.",
      }),
    ),
    db: t.Optional(
      t.String({
        minLength: 1,
        description:
          "A database from `duckdb.open`. Default: a new in-memory database that is gone when the query returns.",
      }),
    ),
    maxRows: t.Optional(
      t.Integer({
        minimum: 1,
        description: `Return at most this many rows. Default: ${DEFAULT_MAX_ROWS}.`,
      }),
    ),
  },
  { additionalProperties: false },
);

type Rows = Record<string, unknown>[];
type Query = Omit<t.Static<typeof queryInput>, "db">;

interface QueryResult {
  columns: { name: string; type: string }[];
  rows: Rows;
  truncated: boolean;
}

function quoted(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * One DuckDB database and the one connection to it. A connection runs one
 * statement at a time, so calls wait their turn.
 */
class Database {
  private turn: Promise<unknown> = Promise.resolve();
  /** Set when closing starts, so nothing more of what waits or runs is started. */
  private closing = false;

  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly connection: DuckDBConnection,
  ) {}

  /** Open a database, in memory or on a file, and run the connection's `init` SQL on it. */
  static async open(
    path: string | undefined,
    init?: string,
  ): Promise<Database> {
    const instance = await DuckDBInstance.create(path ?? ":memory:");
    try {
      const database = new Database(instance, await instance.connect());
      if (init) await database.connection.run(init);
      return database;
    } catch (error) {
      instance.closeSync();
      throw error;
    }
  }

  query(input: Query): Promise<QueryResult> {
    const result = this.turn.then(() => this.run(input));
    this.turn = result.catch(() => {});
    return result;
  }

  /**
   * Stop the statement that is running and close, once it has stopped. An
   * interrupt ends one statement, so the steps of a query each check that
   * the database is still open before they start.
   */
  async close(): Promise<void> {
    if (!this.closing) {
      this.closing = true;
      this.connection.interrupt();
      this.turn = this.turn.then(() => {
        this.connection.closeSync();
        this.instance.closeSync();
      });
    }
    await this.turn;
  }

  private stillOpen(): void {
    if (this.closing) throw new Error("duckdb: the database is closed");
  }

  private async run(input: Query): Promise<QueryResult> {
    for (const [name, rows] of Object.entries(input.tables ?? {})) {
      this.stillOpen();
      await this.load(name, rows);
    }
    this.stillOpen();
    const statements = await this.statements(input.sql);
    for (let index = 0; index < statements.count - 1; index++) {
      this.stillOpen();
      const statement = await statements.prepare(index);
      try {
        await statement.run();
      } finally {
        statement.destroySync();
      }
    }
    this.stillOpen();
    const last = await statements.prepare(statements.count - 1);
    try {
      if (input.params) last.bind(input.params);
      const maxRows = input.maxRows ?? DEFAULT_MAX_ROWS;
      // One row past the limit says whether there were more.
      const reader = await last.streamAndReadUntil(maxRows + 1);
      try {
        const names = reader.deduplicatedColumnNames();
        const types = reader.columnTypes();
        const wide = types.map((type) => WIDE_INTEGERS.has(type.typeId));
        const all = reader.getRowsJson();
        return {
          columns: names.map((name, index) => ({
            name,
            type: String(types[index]),
          })),
          rows: all
            .slice(0, maxRows)
            .map((row) =>
              Object.fromEntries(
                row.map((value, index) => [
                  names[index],
                  wide[index] ? exactNumber(value) : value,
                ]),
              ),
            ),
          truncated: all.length > maxRows,
        };
      } finally {
        reader.closeSync();
      }
    } finally {
      last.destroySync();
    }
  }

  /**
   * The statements in `sql`. For SQL with no statement in it, only comments
   * or spaces, DuckDB's client fails with a message that names no reason.
   */
  private async statements(sql: string) {
    try {
      return await this.connection.extractStatements(sql);
    } catch (error) {
      if (error instanceof Error && error.message === NO_STATEMENT)
        throw new Error("duckdb: no statement in `sql`", { cause: error });
      throw error;
    }
  }

  /**
   * Make `rows` a temporary table. DuckDB reads JSON from files, and works
   * out each column's type from the values: from all of them, so a value
   * unlike the ones before it widens the column instead of failing the load.
   */
  private async load(name: string, rows: Rows): Promise<void> {
    const directory = mkdtempSync(join(tmpdir(), "codemode-duckdb-"));
    try {
      const file = join(directory, "rows.json");
      writeFileSync(file, JSON.stringify(rows), { mode: 0o600 });
      await this.connection.run(
        `create or replace temp table ${quoted(name)} as select * from read_json_auto($1, sample_size = -1)`,
        [file],
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

/** A wide integer as a number when a number holds it exactly; else the text DuckDB gave. */
function exactNumber(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value;
}

/**
 * The databases each run has open. A run is known by its signal, which the
 * engine makes once per run and aborts when the run ends.
 */
const opened = new WeakMap<AbortSignal, Map<string, Database>>();

/** The databases the run of a call has open. */
function openedBy(ctx: ActionContext): Map<string, Database> | undefined {
  return ctx.signal && opened.get(ctx.signal);
}

function database(ctx: ActionContext, id: string): Database {
  const found = openedBy(ctx)?.get(id);
  if (!found)
    throw new Error(
      `duckdb: no open database ${JSON.stringify(id)}. A database is open from duckdb.open until duckdb.close or the end of the run that opened it.`,
    );
  return found;
}

/**
 * Open a database for a call, with the connection's `init` SQL run on it.
 * The run may end while it opens, and nothing would then close it.
 */
async function openFor(ctx: ActionContext, path?: string): Promise<Database> {
  const { init } = ctx.connection.config;
  const opening = await Database.open(
    path,
    typeof init === "string" && init.trim() ? init : undefined,
  );
  if (ctx.signal?.aborted) {
    await opening.close();
    throw new Error("duckdb: the run ended");
  }
  return opening;
}

const queryOutput = {
  type: "object",
  properties: {
    columns: {
      type: "array",
      description: "The result's columns, in order.",
      items: {
        type: "object",
        properties: { name: { type: "string" }, type: { type: "string" } },
        required: ["name", "type"],
      },
    },
    rows: {
      type: "array",
      description:
        "One object per row, keyed by column name. A 64-bit integer is a number when a number holds it exactly, else a string. A decimal is a string.",
      items: { type: "object" },
    },
    truncated: {
      type: "boolean",
      description: "Whether there were more rows than `maxRows`.",
    },
  },
  required: ["columns", "rows", "truncated"],
};

export default function duckdb(rl: CodemodePluginAPI): void {
  rl.setName("duckdb");
  rl.setVersion(packageVersion(import.meta.url));
  rl.setDescription(
    "Run DuckDB SQL on the machine codemode runs on: over databases it attaches, files, and rows the code passes in. It runs with the permissions of the codemode process.",
  );
  rl.setConnectionSchema(
    t.Object({
      init: t.Optional(
        t.String({
          description:
            "SQL run on every database when it opens. Attach databases and create secrets here, so that code needs no credentials.",
        }),
      ),
    }),
  );

  rl.registerAction("query", {
    access: "write",
    description:
      "Run DuckDB SQL and return its rows. SQL can read and write files, attach other databases, and load extensions. Without `db`, the query runs on a new in-memory database and nothing it creates is kept.",
    hints: { destructive: true, openWorld: true },
    inputSchema: queryInput,
    outputSchema: queryOutput,
    async execute({ db, ...input }, ctx) {
      if (db !== undefined) return database(ctx, db).query(input);
      const own = await openFor(ctx);
      // A close that fails here fails the query's own promise, below.
      const stop = () => void own.close().catch(() => {});
      ctx.signal?.addEventListener("abort", stop, { once: true });
      try {
        return await own.query(input);
      } finally {
        ctx.signal?.removeEventListener("abort", stop);
        await own.close();
      }
    },
  });

  rl.registerAction("open", {
    access: "write",
    description:
      "Open a database that lasts until the run ends, and return its id for `duckdb.query`'s `db`. With `path` it is a file, created when missing, and what is written to it stays. Without, it is in memory.",
    hints: { openWorld: true },
    inputSchema: t.Object(
      {
        path: t.Optional(
          t.String({
            minLength: 1,
            description:
              "The database file. A relative path resolves from the directory codemode runs in. Default: in memory.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    outputSchema: {
      type: "object",
      properties: { db: { type: "string" } },
      required: ["db"],
    },
    async execute({ path }, ctx) {
      const { signal } = ctx;
      if (!signal)
        throw new Error(
          "duckdb: a database is opened by a run, and lasts as long",
        );
      const opening = await openFor(
        ctx,
        path === undefined ? undefined : resolve(path),
      );
      let mine = opened.get(signal);
      if (!mine) {
        const databases = new Map<string, Database>();
        mine = databases;
        opened.set(signal, databases);
        signal.addEventListener(
          "abort",
          () => {
            // The run is over, so a close that fails has no one to tell.
            for (const each of databases.values())
              void each.close().catch(() => {});
            databases.clear();
          },
          { once: true },
        );
      }
      const db = randomBytes(8).toString("hex");
      mine.set(db, opening);
      return { db };
    },
  });

  rl.registerAction("close", {
    access: "write",
    description:
      "Close a database from `duckdb.open` before the run ends. What an in-memory database held is gone.",
    inputSchema: t.Object(
      { db: t.String({ minLength: 1, description: "The database's id." }) },
      { additionalProperties: false },
    ),
    async execute({ db }, ctx) {
      const closing = database(ctx, db);
      openedBy(ctx)?.delete(db);
      await closing.close();
      return { closed: true };
    },
  });
}

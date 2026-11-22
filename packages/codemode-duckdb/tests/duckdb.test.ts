/**
 * The DuckDB package: its actions through a real engine and a real DuckDB,
 * and the package as codemode's package manager loads it.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { describePackage, pluginHarness } from "../../package-tests/harness.js";
import duckdb from "../src/index.js";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

interface Result {
  columns: { name: string; type: string }[];
  rows: Record<string, unknown>[];
  truncated: boolean;
}

const harness = pluginHarness(duckdb, "duckdb");
const codemode = harness.codemode;
const query = (
  input: Record<string, unknown>,
  config?: Record<string, unknown>,
) => harness.call<Result>("query", input, config);

const ENDLESS = "select count(*) from range(100000000000) a, range(1000) b";

/**
 * Run code that a one-second run cannot finish, and check that DuckDB is
 * then idle: its threads would otherwise keep this process's processors
 * busy.
 */
async function quietAfter(code: string): Promise<void> {
  const { error } = await codemode().execute(code, { timeoutMs: 1_000 });
  assert.match(error ?? "", /timed out/);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const before = process.cpuUsage();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const { user, system } = process.cpuUsage(before);
  assert.ok(
    user + system < 500_000,
    `${Math.round((user + system) / 1000)} ms of processor time in an idle second`,
  );
}

describe("duckdb.query", () => {
  it("returns a statement's columns and rows", async () => {
    assert.deepEqual(await query({ sql: "select 1 as a, 'x' as b" }), {
      columns: [
        { name: "a", type: "INTEGER" },
        { name: "b", type: "VARCHAR" },
      ],
      rows: [{ a: 1, b: "x" }],
      truncated: false,
    });
  });

  it("queries rows the code passes in, by table name", async () => {
    const orders = [
      { id: 1, status: "paid", total: 10.5 },
      { id: 2, status: "paid", total: 4 },
      { id: 3, status: "open", total: 7 },
    ];
    const { rows } = await query({
      sql: 'select status, count(*) as n, sum(total) as total from orders join "line items" using (id) group by status order by status',
      tables: { orders, "line items": [{ id: 1 }, { id: 2 }, { id: 3 }] },
    });
    assert.deepEqual(rows, [
      { status: "open", n: 1, total: 7 },
      { status: "paid", n: 2, total: 14.5 },
    ]);
  });

  it("works out a passed table's column types from every row", async () => {
    // DuckDB samples 20,480 rows by default; the last one here is past that.
    const mixed = [
      ...Array.from({ length: 21_000 }, (_, n) => ({ value: n })),
      { value: "text" },
    ];
    const { rows } = await query({
      sql: "select typeof(value) as type, count(*) as n from mixed group by type",
      tables: { mixed },
    });
    assert.deepEqual(rows, [{ type: "JSON", n: 21_001 }]);
    assert.deepEqual(
      (
        await query({
          sql: "select count(*) as n from none",
          tables: { none: [] },
        })
      ).rows,
      [{ n: 0 }],
    );
  });

  it("binds parameters by position and by name", async () => {
    const hostile = "x'; drop table t; --";
    assert.deepEqual(
      (
        await query({
          sql: "select $1 as s, $2 + 1 as n",
          params: [hostile, 2],
        })
      ).rows,
      [{ s: hostile, n: 3 }],
    );
    assert.deepEqual(
      (await query({ sql: "select $who as who", params: { who: null } })).rows,
      [{ who: null }],
    );
    assert.equal(
      (await query({ sql: "select * from range(10) limit $1", params: [3] }))
        .rows.length,
      3,
    );
  });

  it("runs every statement and returns the last one's rows", async () => {
    const { rows } = await query({
      sql: "create table t as select 1 as a; insert into t values (2); select a from t where a >= $1",
      params: [2],
    });
    assert.deepEqual(rows, [{ a: 2 }]);
  });

  it("returns values as JSON holds them", async () => {
    const { rows } = await query({
      sql: `select 9007199254740991::bigint as fits, 9007199254740993::bigint as wide,
            1.50::decimal(10,2) as money, date '2026-01-02' as day,
            [1, 2] as list, {'x': 1} as record, null as nothing`,
    });
    assert.deepEqual(rows, [
      {
        fits: 9007199254740991,
        wide: "9007199254740993",
        money: "1.50",
        day: "2026-01-02",
        list: [1, 2],
        record: { x: 1 },
        nothing: null,
      },
    ]);
  });

  it("names a repeated column apart", async () => {
    const { columns, rows } = await query({ sql: "select 1 as a, 2 as a" });
    assert.deepEqual(
      columns.map(({ name }) => name),
      Object.keys(rows[0]),
    );
    assert.deepEqual(Object.values(rows[0]), [1, 2]);
  });

  it("returns at most maxRows rows and says when there were more", async () => {
    const some = await query({ sql: "select * from range(50000)", maxRows: 3 });
    assert.deepEqual(some.rows, [{ range: 0 }, { range: 1 }, { range: 2 }]);
    assert.equal(some.truncated, true);
    const all = await query({ sql: "select * from range(3)", maxRows: 3 });
    assert.equal(all.rows.length, 3);
    assert.equal(all.truncated, false);
  });

  it("reads and writes files", async () => {
    const source = join(harness.tmp, "in.csv");
    const target = join(harness.tmp, "out.json");
    writeFileSync(source, "name,n\na,1\nb,2\n");
    const { rows } = await query({
      sql: `copy (select name, n * 10 as n from read_csv($1)) to '${target}' (array true)`,
      params: [source],
    });
    assert.deepEqual(rows, [{ Count: 2 }]);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), [
      { name: "a", n: 10 },
      { name: "b", n: 20 },
    ]);
  });

  it("keeps nothing from one call to the next", async () => {
    const { result, error } = await codemode().execute(`
      await duckdb.query({ sql: "create table kept as select 1 as a" });
      try {
        await duckdb.query({ sql: "select * from kept" });
      } catch (e) {
        return e.message;
      }
    `);
    assert.equal(error, undefined);
    assert.match(String(result), /Table with name kept does not exist/);
  });

  it("rejects with DuckDB's own error", async () => {
    const { error } = await codemode().execute(
      `return await duckdb.query({ sql: "selec 1" })`,
    );
    assert.match(error ?? "", /Parser Error: syntax error at or near "selec"/);
    const none = await codemode().execute(
      `return await duckdb.query({ sql: "-- nothing" })`,
    );
    assert.match(none.error ?? "", /duckdb: no statement in `sql`/);
  });

  it("stops a query when the run ends", async () => {
    await quietAfter(`return await duckdb.query({ sql: "${ENDLESS}" })`);
  });

  it("refuses input that is not a query", async () => {
    for (const input of [
      {},
      { sql: "" },
      { sql: "select 1", maxRows: 0 },
      { sql: "select 1", params: [{ nested: true }] },
      { sql: "select 1", table: {} },
    ]) {
      const { error } = await codemode().execute(
        `return await duckdb.query(${JSON.stringify(input)})`,
      );
      assert.match(error ?? "", /Invalid input for duckdb\.query/);
    }
  });
});

describe("a database from duckdb.open", () => {
  it("keeps tables between queries until it is closed", async () => {
    const { result, error } = await codemode().execute(`
      const { db } = await duckdb.open({});
      await duckdb.query({ db, sql: "create table kept as select 42 as answer" });
      await duckdb.query({ db, sql: "select 1", tables: { passed: [{ id: 7 }] } });
      const found = await duckdb.query({ db, sql: "select answer, id from kept, passed" });
      const closed = await duckdb.close({ db });
      let after;
      try {
        await duckdb.query({ db, sql: "select 1" });
      } catch (e) {
        after = e.message;
      }
      return { rows: found.rows, closed, after };
    `);
    assert.equal(error, undefined);
    const found = result as { rows: unknown; closed: unknown; after: string };
    assert.deepEqual(found.rows, [{ answer: 42, id: 7 }]);
    assert.deepEqual(found.closed, { closed: true });
    assert.match(found.after, /duckdb: no open database/);
  });

  it("runs queries made together one after another", async () => {
    const { result, error } = await codemode().execute(`
      const { db } = await duckdb.open({});
      await duckdb.query({ db, sql: "create table n (i integer)" });
      await Promise.all([1, 2, 3, 4].map((i) =>
        duckdb.query({ db, sql: "insert into n values ($1)", params: [i] })));
      return (await duckdb.query({ db, sql: "select sum(i) as total from n" })).rows;
    `);
    assert.equal(error, undefined);
    assert.deepEqual(result, [{ total: 10 }]);
  });

  it("ends with the run that opened it", async () => {
    const engine = codemode();
    const first = await engine.execute(`
      const { db } = await duckdb.open({});
      await duckdb.query({ db, sql: "create table kept as select 1 as a" });
      return db;
    `);
    assert.equal(first.error, undefined);
    const second = await engine.execute(
      `return await duckdb.query({ db: ${JSON.stringify(first.result)}, sql: "select * from kept" })`,
    );
    assert.match(second.error ?? "", /duckdb: no open database/);
  });

  it("is a file when given a path, and what it holds stays", async () => {
    const path = join(harness.tmp, "kept.duckdb");
    const write = await codemode().execute(`
      const { db } = await duckdb.open({ path: ${JSON.stringify(path)} });
      await duckdb.query({ db, sql: "create table kept as select 42 as answer" });
    `);
    assert.equal(write.error, undefined);
    assert.equal(existsSync(path), true);
    // The first run's end closed the file, so a second can open it.
    const read = await codemode().execute(`
      const { db } = await duckdb.open({ path: ${JSON.stringify(path)} });
      return (await duckdb.query({ db, sql: "select * from kept" })).rows;
    `);
    assert.equal(read.error, undefined);
    assert.deepEqual(read.result, [{ answer: 42 }]);
  });

  it("stops its query, and those waiting, when the run ends", async () => {
    await quietAfter(`
      const { db } = await duckdb.open({});
      return await Promise.all([1, 2, 3].map(() =>
        duckdb.query({ db, sql: "${ENDLESS}" })));
    `);
  });

  it("is refused by duckdb.close when it is not open", async () => {
    const { error } = await codemode().execute(
      `return await duckdb.close({ db: "nothing" })`,
    );
    assert.match(error ?? "", /duckdb: no open database "nothing"/);
  });
});

describe("the connection's init SQL", () => {
  const init = "create table settings as select 'eu' as region";

  it("runs on every database when it opens", async () => {
    assert.deepEqual(
      (await query({ sql: "select region from settings" }, { init })).rows,
      [{ region: "eu" }],
    );
    const { result, error } = await codemode({ init }).execute(`
      const { db } = await duckdb.open({});
      return (await duckdb.query({ db, sql: "select region from settings" })).rows;
    `);
    assert.equal(error, undefined);
    assert.deepEqual(result, [{ region: "eu" }]);
  });

  it("fails the call when it fails", async () => {
    const { error } = await codemode({ init: "select * from missing" }).execute(
      `return await duckdb.query({ sql: "select 1" })`,
    );
    assert.match(error ?? "", /Table with name missing does not exist/);
  });
});

describePackage(PACKAGE, {
  package: "@shiftlabs/codemode-duckdb",
  plugin: "duckdb",
  actions: 3,
  write: 3,
});

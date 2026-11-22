# codemode-duckdb

A [codemode](../../README.md) package with one plugin, `duckdb`, that runs [DuckDB](https://duckdb.org) SQL over databases, files, and rows the code fetched with other actions.

Install it where code should join, filter, or aggregate more than it can handle row by row. It is not a sandbox: SQL reads and writes files and reaches the network with the permissions of the codemode process.

## Install

Install the package. It needs no connection:

```bash
codemode install npm:@shiftlabs/codemode-duckdb
```

It needs a codemode newer than 0.46.0. DuckDB comes with the package, about 65 MB for one platform.

## Query rows

`duckdb.query` runs SQL and returns its rows. Pass rows from other actions in `tables`, by table name:

```js
const orders = await shop.order.list({ since: "2026-01-01" });
const { rows } = await duckdb.query({
  sql: "select status, count(*) as n, sum(total) as total from orders where total > $min group by status",
  tables: { orders },
  params: { min: 10 },
});
// [{ status: "open", n: 1, total: 70 }, { status: "paid", n: 2, total: 145.5 }]
```

| Input | Meaning |
|---|---|
| `sql` | DuckDB SQL. Of several statements, all run and the last one's rows return |
| `params` | Values for the last statement's parameters: a list for `$1`, `$2`, or an object for `$name` |
| `tables` | Rows to query, by table name. DuckDB works out each column's type from all of the values |
| `db` | A database from `duckdb.open`. The default is a new in-memory database |

Pass values in `params` instead of writing them into the SQL.

| Result | Contents |
|---|---|
| `columns` | Each column's `name` and DuckDB `type`, in order |
| `rows` | One object per row, keyed by column name |
| `totalRows` | How many rows the statement returned |
| `truncated` | Whether `rows` is fewer than all of them |
| `fullOutputPath` | A file with every row, a line of JSON each, when `truncated` |

Code gets every row up to what the host lets an action hold, [8 MiB by default](../../docs/sdk.md#limit-what-an-action-holds). A larger result is read to its end and written to a file in the host's output directory, and `rows` is then the first of them that fit.

What a run returns is a separate matter: codemode cuts it to the host's [output limit](../../docs/sdk.md#limit-a-runs-result), 2,000 lines or 50 KB by default. Aggregate in SQL or pick what matters in code, and return that.

Values arrive as JSON holds them:

| DuckDB type | Value |
|---|---|
| `BIGINT`, `HUGEINT` and their unsigned kinds | A number when a number holds it exactly, else a string |
| `DECIMAL` | A string, such as `"1.50"`. Cast to `DOUBLE` for a number |
| `DATE`, `TIMESTAMP`, `UUID` | A string |
| `LIST`, `STRUCT` | An array, an object |

A statement that changes rows returns one row with their `Count`.

## Query files and databases

SQL reads files directly, and writes them with `copy`:

```js
await duckdb.query({
  sql: "copy (select * from read_parquet($1) where region = $2) to 'eu.csv'",
  params: ["/data/orders/*.parquet", "eu"],
});
```

DuckDB reaches Postgres, MySQL, SQLite, and object storage through extensions, which it downloads on first use. Attach databases in the connection's `init` SQL, so that code needs no credentials:

```bash
codemode connection add duckdb --plugin duckdb \
  --set init="attach 'host=db.internal dbname=shop user=reader password=$PGPASSWORD' as shop (type postgres, read_only)"
```

```js
await duckdb.query({ sql: "select count(*) as n from shop.public.orders" });
```

| Field | Meaning |
|---|---|
| `init` | SQL run on every database when it opens. Attach databases and create secrets here |

## Keep a database for a run

A query's database is gone when the query returns. `duckdb.open` makes one that lasts until the run ends, so several queries see the same tables:

```js
const { db } = await duckdb.open({});
await duckdb.query({ db, sql: "create table orders as select * from fetched", tables: { fetched } });
const late = await duckdb.query({ db, sql: "select * from orders where due < today()" });
const byOwner = await duckdb.query({ db, sql: "select owner, count(*) as n from orders group by owner" });
```

| Action | Result |
|---|---|
| `duckdb.open({ path? })` | Opens a database and returns `{ db }`. With `path` it is a file, created when missing; without, it is in memory |
| `duckdb.close({ db })` | Closes it before the run ends |

Tables passed in `tables` stay in an open database as temporary tables. Queries made together on one database run one after another.

What is written to a file database stays after the run. A relative `path` resolves from the directory codemode runs in.

## Understand the limits

- Every action is labelled `write`, whatever the SQL does.
- A query that is running when the run ends is stopped, and every database the run opened is closed.
- A database belongs to the run that opened it. Another run cannot use its id.
- Rows in `tables` cross from the calling code as JSON. Pass thousands of rows this way, not millions; read larger data from a file or an attached database.
- A table passed with no rows has no columns.
- `init` keeps credentials out of the code, not away from it: SQL reads any file the codemode process can, and DuckDB's errors can quote what `init` attached.
- A list or object inside a row keeps wide integers as strings.
- Extensions download from DuckDB's repository on first use, so a host without outbound network cannot load one it has not loaded before.

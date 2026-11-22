import type { PackageManagerName } from "../packages/manager.js";
import type { PackageEntry } from "../packages/store.js";
import type { ConnectionConfig } from "../plugin/types.js";
import type { OutputLimitSetting } from "../utils/output-limit.js";

export interface CodemodeConfig {
  connections: ConnectionConfig[];
  /** Execution timeout in ms. Default 30_000. */
  timeoutMs: number;
  /** Memory limit for one run in bytes. Default 64MB. */
  memoryLimitBytes: number;
  /**
   * Bodies one pooled worker may run before being retired. Bounds cross-run
   * global contamination; memory is a per-thread cost so this does not
   * meaningfully affect it. Default 500.
   */
  maxRunsPerWorker?: number;
  /**
   * Where output files are written: a command's whole output, a run's whole
   * result, generated media. Default: the system's temporary directory.
   */
  outputDir?: string;
  /**
   * How much a run hands back: its result, error and logs are each cut to
   * this many lines and bytes, with the whole in an output file. Either
   * number can be set alone, and `false` sets no limit. Default: 2000
   * lines and 50 KB.
   */
  outputLimit?: OutputLimitSetting;
  /**
   * How much of what it produces one action may hold in memory and hand to
   * the code that called it. An action that produces output in parts, such
   * as a command or a query, keeps what is past it in an output file.
   * Default: 8 MiB.
   */
  maxActionOutputBytes?: number;
  /** Installed plugin packages; `PackageManager` reads and writes them. */
  packages?: PackageEntry[];
  /** What the CLI installs packages with. Read from the user's config. Default: npm. */
  packageManager?: PackageManagerName;
  /**
   * Bundled plugins a local plugin of the same name replaces. Without its
   * name here, a local plugin named like a bundled one is not loaded.
   */
  replaceableBuiltins?: string[];
}

export const DEFAULT_CONFIG: CodemodeConfig = {
  connections: [],
  timeoutMs: 30_000,
  memoryLimitBytes: 64 * 1024 * 1024,
};

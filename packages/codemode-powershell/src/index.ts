/**
 * PowerShell for codemode: one action that runs a script on the machine
 * codemode runs on and answers what it wrote and how it ended.
 *
 *   const { output, exitCode } = await powershell.run({ command: "Get-ChildItem | Select-Object -First 5" })
 *
 * Every call is a new process, so `Set-Location` and variables do not carry
 * from one call to the next. The command ends with the run that started it.
 */

import { createRequire } from "node:module";
import { win32 } from "node:path";
import type { CodemodePluginAPI } from "@shiftlabs/codemode";
import {
  commandPath,
  pathExists,
  type ShellProgram,
  shellConnectionSchema,
  shellRunAction,
} from "@shiftlabs/codemode/utils/cli";

/** The package's version is the plugin's. */
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

/** No profile and no prompt, so a call runs the same on every machine and never waits for a person. */
const ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];

/** Before the command: output as UTF-8 whatever the console's code page. */
const PREFIX =
  "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}\n";

/**
 * Plain text, without the colour codes PowerShell 7 puts in its errors. It
 * is the environment and not a line of the script because PowerShell reads
 * the whole script before it runs any of it, so a script's line cannot
 * change how that script's own parse error is written.
 */
const ENVIRONMENT = { NO_COLOR: "1" };

/**
 * After the command, in Windows PowerShell 5.1 only. It turns what a
 * program writes to a redirected stderr into error records and sets `$?` to
 * false, so `git push 2>&1 | Select-Object -Last 3` ends in failure although
 * git succeeded. This ends in success when the last failure is only such a
 * record and the program exited 0, and otherwise keeps PowerShell's rule: 0
 * when the last statement succeeded, 1 when it failed. The lone `;` keeps an
 * unfinished last statement, such as `Get-ChildItem |`, a parse error
 * instead of one that continues into these lines.
 */
const WINDOWS_POWERSHELL_SUFFIX = [
  "",
  ";",
  "if ($?) { exit 0 }",
  'if (($LASTEXITCODE -eq 0) -and ("$($Error[0].FullyQualifiedErrorId)" -like "NativeCommandError*")) { exit 0 }',
  "exit 1",
].join("\n");

function isWindowsPowerShell(path: string): boolean {
  return win32.basename(path).toLowerCase() === "powershell.exe";
}

/**
 * The PowerShell to run: the one named, else `pwsh` on `PATH`, else
 * `powershell` on `PATH`. On Windows, also where each installs: PowerShell 7
 * before Windows PowerShell.
 */
export function resolvePowerShell(named?: string): ShellProgram {
  const args = [...ARGS, "-Command"];
  if (named) {
    if (!pathExists(named)) throw new Error(`powershell: no shell at ${named}`);
    return { program: named, args };
  }
  if (process.platform !== "win32") {
    const found = commandPath("pwsh") ?? commandPath("powershell");
    if (!found)
      throw new Error(
        'powershell: no PowerShell found. Install PowerShell, add pwsh to PATH, or set the connection\'s "shell".',
      );
    return { program: found, args };
  }
  const installed = (
    root: string | undefined,
    ...parts: string[]
  ): string | undefined => {
    const path = root && win32.join(root, ...parts);
    return path && pathExists(path) ? path : undefined;
  };
  const found =
    commandPath("pwsh.exe") ??
    installed(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe") ??
    commandPath("powershell.exe") ??
    installed(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
  if (!found)
    throw new Error(
      'powershell: no PowerShell found. Install PowerShell, add pwsh.exe or powershell.exe to PATH, or set the connection\'s "shell".',
    );
  return { program: found, args };
}

/**
 * The script a PowerShell is handed for a command. A command ending in a
 * backtick continues its last line into whatever follows, so it gets no
 * suffix.
 */
export function powershellScript(command: string, program: string): string {
  const suffix =
    isWindowsPowerShell(program) && !command.endsWith("`")
      ? WINDOWS_POWERSHELL_SUFFIX
      : "";
  return `${PREFIX}${command}${suffix}`;
}

export default function powershell(rl: CodemodePluginAPI): void {
  rl.setName("powershell");
  rl.setVersion(version);
  rl.setDescription(
    "Run PowerShell commands on the machine codemode runs on, with the permissions of the codemode process.",
  );
  rl.setConnectionSchema(
    shellConnectionSchema("pwsh on PATH, else powershell on PATH"),
  );
  rl.registerAction(
    "run",
    shellRunAction({
      shell: "PowerShell",
      outputFilePrefix: "codemode-powershell",
      prepare: (command, shell) => {
        const program = resolvePowerShell(shell);
        return {
          program,
          script: powershellScript(command, program.program),
          env: ENVIRONMENT,
        };
      },
    }),
  );
}

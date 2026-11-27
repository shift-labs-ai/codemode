import type { ActionContext, CodemodePluginAPI } from "@shiftlabs/codemode";
import { commandExists, runProgram } from "@shiftlabs/codemode";

/** The variables the docker CLI is pointed at a daemon with: `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG` and the rest. */
function dockerEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0].startsWith("DOCKER_") && entry[1] !== undefined,
    ),
  );
}

/** What `docker` wrote for these arguments. A failure is an error with what docker said. */
async function docker(ctx: ActionContext, args: string[]): Promise<string> {
  const { stdout, stderr, exitCode } = await runProgram(ctx, "docker", args, {
    env: dockerEnvironment(),
  });
  if (exitCode !== 0)
    throw new Error(
      `docker ${args[0]} failed (exit ${exitCode}): ${(stderr || stdout).trim()}`,
    );
  return stdout;
}

/** The rows of a `--format '{{json .}}'` listing: one JSON object a line. */
async function dockerRows(
  ctx: ActionContext,
  args: string[],
): Promise<Record<string, unknown>[]> {
  return (await docker(ctx, [...args, "--format", "{{json .}}", "--no-trunc"]))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

export default function dockerPlugin(rl: CodemodePluginAPI) {
  rl.setName("docker");
  rl.setVersion("0.1.0");

  rl.onInit(() => {
    if (!commandExists("docker")) {
      rl.log.warn(
        "docker not found on PATH — docker actions will be unavailable",
      );
    }
  });

  rl.registerAction("containers.list", {
    access: "read",
    description: "List Docker containers",
    inputSchema: {
      all: {
        type: "boolean",
        description: "Include stopped containers",
        required: false,
      },
    },
    async execute(input, ctx) {
      const opts = (input as { all?: boolean }) ?? {};
      const rows = await dockerRows(ctx, opts.all ? ["ps", "--all"] : ["ps"]);
      return rows.map((r) => ({
        id: r.ID ?? r.id ?? "",
        name: ((r.Names ?? r.names ?? "") as string).replace(/^\//, ""),
        image: r.Image ?? r.image ?? "",
        status: r.Status ?? r.status ?? "",
        state: r.State ?? r.state ?? "",
        ports: r.Ports ?? r.ports ?? "",
      }));
    },
  });

  rl.registerAction("containers.start", {
    access: "write",
    description: "Start a Docker container",
    inputSchema: {
      id: {
        type: "string",
        description: "Container ID or name",
        required: true,
      },
    },
    async execute(input, ctx) {
      const { id } = input as { id: string };
      await docker(ctx, ["start", id]);
      return { ok: true, id };
    },
  });

  rl.registerAction("containers.stop", {
    access: "write",
    description: "Stop a Docker container",
    inputSchema: {
      id: {
        type: "string",
        description: "Container ID or name",
        required: true,
      },
    },
    async execute(input, ctx) {
      const { id } = input as { id: string };
      await docker(ctx, ["stop", id]);
      return { ok: true, id };
    },
  });

  rl.registerAction("images.list", {
    access: "read",
    description: "List Docker images",
    async execute(_input, ctx) {
      const rows = await dockerRows(ctx, ["images"]);
      return rows.map((r) => ({
        id: r.ID ?? r.id ?? "",
        repository: r.Repository ?? r.repository ?? "",
        tag: r.Tag ?? r.tag ?? "",
        size: r.Size ?? r.size ?? "",
      }));
    },
  });

  rl.registerAction("images.pull", {
    access: "write",
    description: "Pull a Docker image",
    inputSchema: {
      image: {
        type: "string",
        description: "Image name (e.g. nginx:latest)",
        required: true,
      },
    },
    async execute(input, ctx) {
      const { image } = input as { image: string };
      await docker(ctx, ["pull", image]);
      return { ok: true, image };
    },
  });
}

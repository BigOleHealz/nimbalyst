import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";

const exec = promisify(execFile);
export interface WorkspaceContext {
  files: string[];
  commands: Array<{
    name: string;
    description?: string;
    content: string;
    source: "project";
    kind: "command" | "skill";
  }>;
}

/** Only the selected checkout's explicit command files; never ambient host settings/plugins. */
export async function readWorkspaceContext(
  workspace: string
): Promise<WorkspaceContext> {
  const root = await realpath(workspace);
  let stdout: string;
  try {
    ({stdout} = await exec(
      "git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {cwd: root, maxBuffer: 2 * 1024 * 1024},
    ));
  } catch (error) {
    // A persistent multi-repo session root contains Git worktrees, rather than being a repo itself.
    const children = await readdir(root, {withFileTypes: true});
    const repositories: string[] = [];
    for (const child of children) {
      if (!child.isDirectory() || child.isSymbolicLink()) continue;
      if (await stat(join(root, child.name, '.git')).catch(() => null)) repositories.push(child.name);
    }
    if (!repositories.length) throw error;
    const contexts = await Promise.all(repositories.map(async name => ({name, context: await readWorkspaceContext(join(root, name))})));
    return {
      files: contexts.flatMap(({name, context}) => context.files.map(file => `${name}/${file}`)).slice(0,2000),
      commands: contexts.flatMap(({name, context}) => context.commands.map(command => ({...command, name: `${name}:${command.name}`, content: `Run this project command from ${join(root, name)}.\n\n${command.content}`}))).slice(0,100),
    };
  }
  const files = [...new Set(stdout.split("\0").filter(Boolean))].slice(0, 2000);
  const commands: WorkspaceContext["commands"] = [];
  let total = 0;
  async function walk(
    directory: string,
    prefix: string,
    kind: "command" | "skill",
    depth = 0
  ): Promise<void> {
    if (depth > 4 || commands.length >= 100) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => []
    );
    for (const entry of entries) {
      if (commands.length >= 100 || total >= 250000) return;
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path, `${prefix}${entry.name}:`, kind, depth + 1);
        continue;
      }
      if (
        !entry.isFile() ||
        !entry.name.endsWith(".md") ||
        (kind === "skill" && entry.name !== "SKILL.md")
      )
        continue;
      const resolved = await realpath(path);
      const rel = relative(root, resolved);
      if (rel.startsWith("..") || isAbsolute(rel)) continue;
      if ((await stat(resolved)).size > 32000) continue;
      const content = await readFile(resolved, "utf8");
      total += content.length;
      if (content.length > 32000 || total > 250000) continue;
      const name =
        kind === "skill"
          ? prefix.replace(/:$/, "")
          : `${prefix}${entry.name.slice(0, -3)}`;
      commands.push({ name, content, source: "project", kind });
    }
  }
  await walk(join(root, ".claude", "commands"), "", "command");
  await walk(join(root, ".agents", "skills"), "", "skill");
  await walk(join(root, ".claude", "skills"), "", "skill");
  return { files, commands };
}

export async function expandRemoteCommand(
  prompt: string,
  workspace: string
): Promise<string> {
  const match = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
  if (!match) return prompt;
  const command = (await readWorkspaceContext(workspace)).commands.find(
    (command) => command.name === match[1]
  );
  if (!command)
    throw new Error(
      `/${match[1]} is not available on this machine. Add the command to this checkout before running it.`
    );
  return `${command.content.replace(
    /\$ARGUMENTS/g,
    match[2] ?? ""
  )}\n\nUser arguments: ${match[2] ?? ""}`;
}

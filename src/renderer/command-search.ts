export type CommandKind = "page" | "action" | "instance";
export type CommandScope = "all" | CommandKind | "recent";
export interface SearchCommand {
  key: string;
  kind: CommandKind;
  label: string;
  description: string;
  keywords?: string;
}
export const recentKey = "ark.palette-recent";
const limit = 8;
export function recentKeys(saved: unknown): string[] {
  if (!Array.isArray(saved)) return [];
  return [
    ...new Set(
      saved.filter(
        (key): key is string =>
          typeof key === "string" &&
          /^(page|action|instance):.{1,100}$/.test(key),
      ),
    ),
  ].slice(0, limit);
}
export function rememberCommand(saved: string[], key: string) {
  return recentKeys([key, ...saved]);
}
const normalize = (text: string) => text.normalize("NFKC").trim().toLowerCase();
export function searchCommands<T extends SearchCommand>(
  commands: T[],
  query: string,
  scope: CommandScope,
  recent: string[],
): T[] {
  const term = normalize(query);
  const words = term.split(/\s+/).filter(Boolean);
  return commands
    .flatMap((command) => {
      const index = recent.indexOf(command.key);
      if (
        scope === "recent"
          ? index < 0
          : scope !== "all" && command.kind !== scope
      )
        return [];
      const label = normalize(command.label);
      const text = normalize(
        [
          command.label,
          command.description,
          command.keywords,
          command.key,
        ].join(" "),
      );
      if (!words.every((word) => text.includes(word))) return [];
      const relevance = !term
        ? 0
        : label === term
          ? 3
          : label.startsWith(term)
            ? 2
            : label.includes(term)
              ? 1
              : 0;
      return [{ command, relevance, recentRank: index < 0 ? limit : index }];
    })
    .sort((a, b) => b.relevance - a.relevance || a.recentRank - b.recentRank)
    .map(({ command }) => command);
}

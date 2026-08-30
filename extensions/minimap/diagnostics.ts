import type {
  AssistantMessage,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { stripVTControlCharacters } from "node:util";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  addUsage,
  emptyCounts,
  emptyUsage,
  stateFromEntry,
  type ContextReset,
  type SessionStats,
} from "./state.ts";

export const categorizeError = (
  message: Pick<ToolResultMessage, "toolName" | "content">,
): string => {
  const text = message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
  if (/(?:✖|not ok|# fail [1-9]|tests?[\s\S]{0,40}failed)/i.test(text))
    return "test";
  if (/error TS\d+/.test(text)) return "typecheck";
  if (/SyntaxError|triggerUncaughtException|ERR_[A-Z_]+/.test(text))
    return "runtime";
  if (/Command exited|fatal:/i.test(text)) return "command";
  return oneLine(message.toolName, 24) || "tool";
};

export const collectContextResets = (
  entries: SessionEntry[],
  contextWindow: number,
  currentTokens?: number | null,
): ContextReset[] => {
  const resets: ContextReset[] = [];
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const entry = entries[entryIndex];
    if (entry?.type !== "compaction") continue;
    let afterTokens: number | undefined;
    let followedByCompaction = false;
    for (
      let nextIndex = entryIndex + 1;
      nextIndex < entries.length;
      nextIndex++
    ) {
      const next = entries[nextIndex];
      if (next?.type === "compaction") {
        followedByCompaction = true;
        break;
      }
      if (next?.type !== "message" || next.message.role !== "assistant")
        continue;
      const message = next.message;
      if (message.stopReason === "aborted" || message.stopReason === "error")
        continue;
      if (message.usage.totalTokens > 0) {
        afterTokens = message.usage.totalTokens;
        break;
      }
    }
    if (!followedByCompaction && afterTokens == null && currentTokens != null)
      afterTokens = currentTokens;
    resets.push({
      entryIndex,
      beforePercent:
        contextWindow > 0 ? (entry.tokensBefore / contextWindow) * 100 : null,
      afterPercent:
        contextWindow > 0 && afterTokens != null
          ? (afterTokens / contextWindow) * 100
          : null,
    });
  }
  return resets;
};

export const collectStats = (entries: SessionEntry[]): SessionStats => {
  const stats: SessionStats = {
    ...emptyUsage(),
    tools: emptyCounts(),
    skills: extractSkills(entries),
    errors: 0,
    errorKinds: emptyCounts(),
    agentTokens: 0,
    summaryTokens: 0,
    toolTokens: emptyCounts(),
  };

  for (const entry of entries) {
    const openState = stateFromEntry(entry);
    if (openState) {
      addUsage(stats, openState.callUsage);
      stats.summaryTokens += openState.callUsage.totalTokens;
      continue;
    }
    if (entry.type !== "message") continue;

    if (entry.message.role === "assistant") {
      const message = entry.message;
      addUsage(stats, message.usage);
      stats.agentTokens += message.usage.totalTokens;
      if (message.stopReason === "error") {
        stats.errors++;
        stats.errorKinds.model = (stats.errorKinds.model ?? 0) + 1;
      }
      for (const content of message.content) {
        if (content.type === "toolCall") {
          stats.tools[content.name] = (stats.tools[content.name] ?? 0) + 1;
        }
      }
    } else if (entry.message.role === "toolResult") {
      const message = entry.message;
      addUsage(stats, message.usage);
      if (message.usage) {
        const tokens = message.usage.totalTokens;
        stats.agentTokens += tokens;
        stats.toolTokens[message.toolName] =
          (stats.toolTokens[message.toolName] ?? 0) + tokens;
      }
      if (message.isError) {
        stats.errors++;
        const kind = categorizeError(message);
        stats.errorKinds[kind] = (stats.errorKinds[kind] ?? 0) + 1;
      }
    }
  }

  return stats;
};

export const collectStepStats = (entries: SessionEntry[]) => {
  const stats = collectStats(entries.filter((entry) => !stateFromEntry(entry)));
  return {
    tools: stats.tools,
    errors: stats.errors,
    usage: {
      input: stats.input,
      output: stats.output,
      cacheRead: stats.cacheRead,
      totalTokens: stats.agentTokens,
      cost: stats.cost,
    },
  };
};

export const textContent = (
  content: string | AssistantMessage["content"] | ToolResultMessage["content"],
): string =>
  typeof content === "string"
    ? content
    : content
        .flatMap((item) => (item.type === "text" ? [item.text] : []))
        .join("\n");

export const extractSkills = (
  entries: SessionEntry[],
): Record<string, number> => {
  const skills = emptyCounts();
  const count = (name: string) => {
    skills[name] = (skills[name] ?? 0) + 1;
  };

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "user") {
      const text = textContent(entry.message.content);
      for (const match of text.matchAll(/<skill\s+name=["']([^"']+)["']/gi)) {
        if (match[1]) count(match[1]);
      }
    } else if (entry.message.role === "assistant") {
      for (const content of entry.message.content) {
        if (content.type !== "toolCall" || content.name !== "read") continue;
        const path = content.arguments.path;
        if (typeof path !== "string") continue;
        const match = path.match(/(?:^|\/)skills\/([^/]+)\/SKILL\.md$/);
        if (match?.[1]) count(match[1]);
      }
    }
  }
  return skills;
};

export const isStandaloneSkillInjection = (text: string): boolean =>
  /^<skill\s+name=["'][^"']+["'][^>]*>[\s\S]*<\/skill>$/.test(text.trim());

const stripTerminalStrings = (text: string): string => {
  let safe = "";
  for (let index = 0; index < text.length; ) {
    const code = text.charCodeAt(index);
    const next = text[index + 1] ?? "";
    const stringControl =
      (code === 27 && "]P^_X".includes(next)) ||
      code === 144 ||
      code === 152 ||
      code === 157 ||
      code === 158 ||
      code === 159;
    if (!stringControl) {
      safe += text[index];
      index++;
      continue;
    }
    index += code === 27 ? 2 : 1;
    while (index < text.length) {
      if (text.charCodeAt(index) === 7 || text.charCodeAt(index) === 156) {
        index++;
        break;
      }
      if (text.charCodeAt(index) === 27 && text[index + 1] === "\\") {
        index += 2;
        break;
      }
      index++;
    }
  }
  return safe;
};

const terminalSafe = (text: string): string =>
  Array.from(stripVTControlCharacters(stripTerminalStrings(text)))
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        code === 9 ||
        code === 10 ||
        code === 13 ||
        (code >= 32 &&
          code !== 127 &&
          (code < 128 || code > 159) &&
          (code < 8234 || code > 8238) &&
          (code < 8294 || code > 8297))
      );
    })
    .join("");

export const oneLine = (text: string, max = 180): string =>
  terminalSafe(text)
    .replace(/^[\s#*•-]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const failurePatternDetail = (
  content: ToolResultMessage["content"],
  type: string,
): string => {
  const detail = textContent(content)
    .split(/\r?\n/)
    .map((line) => terminalSafe(line).trim())
    .find(
      (line) =>
        !/^[>$]/.test(line) &&
        /\b(error|fatal|fail(?:ed|ure)?|not found|no such file|timed? out|denied|invalid|cannot|unexpected|missing|stale|exited|HTTP\s+[45]\d\d)\b|[✖×]/i.test(
          line,
        ),
    );
  if (!detail) return `${type} failure`;
  const sanitized = detail
    .replace(/^Error:\s*/i, "")
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/(?:[A-Za-z]:[\\/]|~\/|\/)(?:[^\s:]+[\\/])*[^\s:]*/g, "<path>")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "<redacted>")
    .replace(/\b\d+\b/g, "#")
    .replace(/\s*\(or any of the parent directories\)\s*/gi, " ");
  return oneLine(sanitized, 56) || `${type} failure`;
};

export const failureReview = (
  entries: SessionEntry[],
  callsByTool: Record<string, number>,
) => {
  const failuresByTool = emptyCounts();
  const byType = emptyCounts();
  const patternCounts = new Map<string, number>();
  let total = 0;
  let runs = 0;
  let recovered = 0;
  let streak = 0;
  let maxStreak = 0;
  const recover = () => {
    if (!streak) return;
    recovered++;
    streak = 0;
  };
  const recordFailure = (type: string, pattern: string) => {
    if (!streak) runs++;
    streak++;
    maxStreak = Math.max(maxStreak, streak);
    total++;
    byType[type] = (byType[type] ?? 0) + 1;
    patternCounts.set(pattern, (patternCounts.get(pattern) ?? 0) + 1);
  };

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "toolResult") {
      if (!message.isError) {
        recover();
        continue;
      }
      failuresByTool[message.toolName] =
        (failuresByTool[message.toolName] ?? 0) + 1;
      const type = categorizeError(message);
      recordFailure(
        type,
        `${oneLine(message.toolName, 24)}: ${failurePatternDetail(message.content, type)}`,
      );
    } else if (message.role === "assistant") {
      if (message.stopReason === "error") {
        recordFailure(
          "model",
          `model: ${oneLine(message.errorMessage ?? "model failure")}`,
        );
      } else if (message.stopReason !== "toolUse") {
        recover();
      }
    }
  }

  const byTool = Object.entries(failuresByTool)
    .map(([name, failures]) => {
      const calls = callsByTool[name] ?? 0;
      return {
        name,
        failures,
        calls,
        rate: calls ? (failures / calls) * 100 : 0,
      };
    })
    .sort(
      (a, b) =>
        b.failures - a.failures ||
        b.rate - a.rate ||
        a.name.localeCompare(b.name),
    );
  const patterns = [...patternCounts]
    .filter(([, count]) => count > 1)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return {
    total,
    runs,
    recovered,
    unresolved: streak ? 1 : 0,
    maxStreak,
    byTool,
    byType,
    patterns,
  };
};

export const conciseStep = (text: string, maxWords = 10): string => {
  const normalized = oneLine(text);
  const firstClause = normalized.split(";")[0]?.trim() || normalized;
  return firstClause
    .split(/\s+/)
    .slice(0, maxWords)
    .join(" ")
    .replace(/[,:-]+$/, "");
};

export const readableGoal = (text: string): string => {
  const images = [...text.matchAll(/\.(?:png|jpe?g|gif|webp)/gi)];
  const first = images[0];
  const last = images.at(-1);
  if (first?.index == null || last?.index == null) return conciseStep(text);
  const after = text.slice(last.index + last[0].length).trim();
  if (after) return conciseStep(after);
  const before = text.slice(0, first.index);
  const pathStart = before.search(/(?:^|\s)\//);
  return conciseStep(
    (pathStart < 0 ? before : before.slice(0, pathStart)).replace(
      /\bWorked on\s*$/i,
      "",
    ),
  );
};

export const isConsequentialDecision = (text: string): boolean =>
  Boolean(conciseStep(text, 14)) &&
  !/\b(?:wording|layout|labels?|icons?|tests?|refactor(?:ing)?|deferred follow-up)\b/i.test(
    text,
  ) &&
  !/\b(?:suppress|sanitize)\b.*\b(?:commands?|paths?|volatile numbers?|error summaries?)\b/i.test(
    text,
  );

import { normalizeOpenzaloAllowEntry } from "./normalize.js";
import type { OpenzaloInboundMention } from "./types.js";

function resolveOwnMentionTextCandidates(params: {
  mentions?: OpenzaloInboundMention[];
  botUserId?: string;
}): string[] {
  const ownBotUserId = params.botUserId ? normalizeOpenzaloAllowEntry(params.botUserId) : "";
  if (!ownBotUserId || !params.mentions?.length) {
    return [];
  }

  const texts = new Set<string>();
  for (const mention of params.mentions) {
    if (normalizeOpenzaloAllowEntry(mention.uid) !== ownBotUserId) {
      continue;
    }
    const rawText = mention.text?.trim();
    if (!rawText) {
      continue;
    }
    texts.add(rawText.startsWith("@") ? rawText : `@${rawText}`);
  }
  return Array.from(texts).sort((left, right) => right.length - left.length);
}

function consumeOwnMentionTextPrefix(params: {
  text: string;
  mentions?: OpenzaloInboundMention[];
  botUserId?: string;
}): { matched: boolean; rest: string } {
  for (const candidate of resolveOwnMentionTextCandidates(params)) {
    if (!params.text.startsWith(candidate)) {
      continue;
    }
    const nextChar = params.text[candidate.length] ?? "";
    if (nextChar && !/[\s,:;|./!-]/.test(nextChar)) {
      continue;
    }
    return {
      matched: true,
      rest: params.text.slice(candidate.length).trimStart(),
    };
  }
  return {
    matched: false,
    rest: params.text,
  };
}

function buildOwnMentionPrefixPatterns(mentionRegexes: RegExp[]): RegExp[] {
  return mentionRegexes.flatMap((mentionRegex) => {
    try {
      const flags = mentionRegex.flags.includes("i") ? "i" : "";
      return [
        new RegExp(`^(?:${mentionRegex.source})(?:[\\s,:;|.-]+|$)`, flags),
        new RegExp(`^(?:${mentionRegex.source})(?=[/!])`, flags),
      ];
    } catch {
      return [];
    }
  });
}

function consumeOwnMentionPrefix(params: {
  text: string;
  mentionRegexes: RegExp[];
  mentions?: OpenzaloInboundMention[];
  botUserId?: string;
}): { matched: boolean; rest: string } {
  const exactMentionText = consumeOwnMentionTextPrefix({
    text: params.text,
    mentions: params.mentions,
    botUserId: params.botUserId,
  });
  if (exactMentionText.matched) {
    return exactMentionText;
  }

  const prefixPatterns = buildOwnMentionPrefixPatterns(params.mentionRegexes);
  for (const pattern of prefixPatterns) {
    const match = params.text.match(pattern);
    if (!match?.[0]) {
      continue;
    }
    return {
      matched: true,
      rest: params.text.slice(match[0].length).trimStart(),
    };
  }
  return {
    matched: false,
    rest: params.text,
  };
}

function startsWithOwnMention(params: {
  text: string;
  mentionRegexes: RegExp[];
  mentions?: OpenzaloInboundMention[];
  botUserId?: string;
}): boolean {
  const consumed = consumeOwnMentionPrefix({
    text: params.text,
    mentionRegexes: params.mentionRegexes,
    mentions: params.mentions,
    botUserId: params.botUserId,
  });
  if (consumed.matched) {
    return true;
  }
  const ownBotUserId = params.botUserId ? normalizeOpenzaloAllowEntry(params.botUserId) : "";
  if (!ownBotUserId) {
    return false;
  }
  const simpleTarget = params.text.match(/^@(\S+)/)?.[1] ?? "";
  return Boolean(simpleTarget) && normalizeOpenzaloAllowEntry(simpleTarget) === ownBotUserId;
}

export function resolveOpenzaloCommandBody(params: {
  rawBody: string;
  mentionRegexes: RegExp[];
  mentions?: OpenzaloInboundMention[];
  botUserId?: string;
}): string {
  const trimmed = params.rawBody.trim();
  if (!trimmed) {
    return "";
  }
  if (/^[/!]/.test(trimmed)) {
    return trimmed;
  }

  let rest = trimmed;
  let strippedMention = false;

  for (let i = 0; i < 3; i += 1) {
    const consumed = consumeOwnMentionPrefix({
      text: rest,
      mentionRegexes: params.mentionRegexes,
      mentions: params.mentions,
      botUserId: params.botUserId,
    });
    if (!consumed.matched) {
      break;
    }
    rest = consumed.rest;
    strippedMention = true;
  }

  if (strippedMention && /^[/!]/.test(rest)) {
    return rest;
  }
  return trimmed;
}

export function doesOpenzaloCommandTargetDifferentBot(params: {
  commandBody: string;
  mentionRegexes: RegExp[];
  mentions?: OpenzaloInboundMention[];
  botUserId?: string;
}): boolean {
  const trimmed = params.commandBody.trim();
  const match = trimmed.match(/^[/!][^\s]+(?:\s+(.*))?$/);
  if (!match) {
    return false;
  }

  const args = (match[1] ?? "").trimStart();
  if (!args.startsWith("@")) {
    return false;
  }

  return !startsWithOwnMention({
    text: args,
    mentionRegexes: params.mentionRegexes,
    mentions: params.mentions,
    botUserId: params.botUserId,
  });
}

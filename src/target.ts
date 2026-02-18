export type OpenzaloThreadTarget = {
  threadId: string;
  isGroup: boolean;
};

type ParsedTarget = {
  threadId: string;
  explicitKind: "group" | "user" | "unqualified";
};

export function normalizeOpenzaloTarget(rawTarget: string): string {
  const cleaned = rawTarget.replace(/^(openzalo|zlu):/i, "").trim();
  if (!cleaned) {
    return "";
  }
  const lowered = cleaned.toLowerCase();
  if (lowered.startsWith("group:") || lowered.startsWith("user:")) {
    return cleaned;
  }
  const aliasMatch = cleaned.match(/^([gu])-(\d{3,})$/i);
  if (aliasMatch) {
    const kind = aliasMatch[1]?.toLowerCase() === "g" ? "group" : "user";
    const id = aliasMatch[2] ?? "";
    return `${kind}:${id}`;
  }
  const labeledIdMatch = cleaned.match(/\((\d{3,})\)\s*$/);
  if (labeledIdMatch?.[1]) {
    return labeledIdMatch[1];
  }
  return cleaned;
}

function parseOpenzaloTarget(rawTarget: string): ParsedTarget {
  const normalized = normalizeOpenzaloTarget(rawTarget);
  if (normalized.toLowerCase().startsWith("group:")) {
    return {
      threadId: normalized.slice("group:".length).trim(),
      explicitKind: "group",
    };
  }
  if (normalized.toLowerCase().startsWith("user:")) {
    return {
      threadId: normalized.slice("user:".length).trim(),
      explicitKind: "user",
    };
  }
  return { threadId: normalized, explicitKind: "unqualified" };
}

export function parseOpenzaloActionTarget(rawTarget: string): OpenzaloThreadTarget {
  const parsed = parseOpenzaloTarget(rawTarget);
  return {
    threadId: parsed.threadId,
    isGroup: parsed.explicitKind === "group",
  };
}

export function resolveOpenzaloThreadTarget(params: {
  rawTarget: string;
  isGroup?: boolean;
  hasExplicitTarget?: boolean;
  groupHintTargets?: string[];
  chatType?: string | null;
}): OpenzaloThreadTarget {
  const parsed = parseOpenzaloTarget(params.rawTarget);
  if (!parsed.threadId) {
    throw new Error("thread target required");
  }
  const explicitGroup = typeof params.isGroup === "boolean" ? params.isGroup : undefined;
  if (explicitGroup !== undefined) {
    if (
      parsed.explicitKind !== "unqualified" &&
      (parsed.explicitKind === "group") !== explicitGroup
    ) {
      throw new Error(
        `threadId target "${params.rawTarget}" conflicts with isGroup=${String(explicitGroup)}`,
      );
    }
    return {
      threadId: parsed.threadId,
      isGroup: explicitGroup,
    };
  }
  if (parsed.explicitKind === "group") {
    return {
      threadId: parsed.threadId,
      isGroup: true,
    };
  }
  if (parsed.explicitKind === "user") {
    return {
      threadId: parsed.threadId,
      isGroup: false,
    };
  }

  const hintTargets = params.groupHintTargets ?? [];
  const hintedGroupTarget = hintTargets
    .map((value) => parseOpenzaloTarget(value))
    .some((value) => value.explicitKind === "group" && value.threadId === parsed.threadId);
  if (hintedGroupTarget) {
    return {
      threadId: parsed.threadId,
      isGroup: true,
    };
  }

  const chatType = params.chatType?.trim().toLowerCase();
  if (chatType === "group") {
    return {
      threadId: parsed.threadId,
      isGroup: true,
    };
  }
  if (chatType === "direct") {
    return {
      threadId: parsed.threadId,
      isGroup: false,
    };
  }

  const isAmbiguousNumericTarget = /^\d{3,}$/.test(parsed.threadId);
  if ((params.hasExplicitTarget ?? true) && isAmbiguousNumericTarget) {
    throw new Error(
      `Ambiguous thread target "${parsed.threadId}". Use "group:${parsed.threadId}" or "user:${parsed.threadId}", or set isGroup explicitly.`,
    );
  }

  return {
    threadId: parsed.threadId,
    isGroup: false,
  };
}

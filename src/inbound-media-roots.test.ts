import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveOpenzaloReplyMediaLocalRoots } from "./inbound.ts";

const baseAccount = {
  accountId: "default",
  enabled: true,
  configured: true,
  profile: "default",
  zcaBinary: "openzca",
};

test("resolveOpenzaloReplyMediaLocalRoots includes the routed agent workspace", async () => {
  const tempDir = path.join(os.tmpdir(), `openzalo-media-roots-${Date.now()}`);
  const workspace = path.join(tempDir, "workspace-friends");
  const configuredRoot = path.join(tempDir, "configured-media");

  const roots = await resolveOpenzaloReplyMediaLocalRoots({
    cfg: {
      agents: {
        defaults: {
          workspace: path.join(tempDir, "workspace"),
        },
        list: [
          {
            id: "owner-admin",
            default: true,
          },
          {
            id: "friends-hat",
            workspace,
          },
        ],
      },
    } as never,
    account: {
      ...baseAccount,
      config: {
        mediaLocalRoots: [configuredRoot],
      },
    },
    agentId: "friends-hat",
  });

  assert.ok(roots?.includes(configuredRoot));
  assert.ok(roots?.includes(workspace));
});

test("resolveOpenzaloReplyMediaLocalRoots derives a non-default workspace from agent defaults", async () => {
  const tempDir = path.join(os.tmpdir(), `openzalo-media-roots-default-${Date.now()}`);
  const roots = await resolveOpenzaloReplyMediaLocalRoots({
    cfg: {
      agents: {
        defaults: {
          workspace: path.join(tempDir, "workspace"),
        },
        list: [
          {
            id: "owner-admin",
            default: true,
          },
          {
            id: "friends-hat",
          },
        ],
      },
    } as never,
    account: {
      ...baseAccount,
      config: {},
    },
    agentId: "friends-hat",
  });

  assert.ok(roots?.includes(path.join(tempDir, "workspace", "friends-hat")));
});

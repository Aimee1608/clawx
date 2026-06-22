// Shared mock data factories for Storybook stories. Keep them deterministic
// (no Math.random / Date.now) so visual snapshots stay stable.

import type {
  ClaudeSessionMeta,
  ConfigResponse,
  StatusResponse,
  UiMessage,
} from '@/api'

export const mockStatus: StatusResponse = {
  mode: 'hub',
  instanceId: '17d04b13-0e28-40f9-8bd3-a63a805ab858',
  uptimeSec: 4523,
  pid: 3268275,
  bindHost: '0.0.0.0',
}

export const mockStatusWs: StatusResponse = {
  ...mockStatus,
  mode: 'ws',
  instanceId: 'a97632e7-f3bd-4b48-9810-6271f1d000d9',
  uptimeSec: 67,
}

export const mockClaudeSession: ClaudeSessionMeta = {
  uuid: '890ad594-f05e-49fd-8d9c-b4a05f79d872',
  projectDir: '-home-user-workspace',
  cwd: '/home/user/workspace',
  entrypoint: 'cli',
  firstPrompt: '你看一下 /home/user/project/docs/README.md ,解决一下',
  firstTs: '2026-04-23T02:31:11.449Z',
  lastModified: '2026-04-27T02:31:11.449Z',
  sizeBytes: 8771,
  inBot: false,
}

export const mockClaudeSessions: ClaudeSessionMeta[] = [
  mockClaudeSession,
  {
    uuid: 'e4711656-da38-4a6d-84d5-a579f270dfd0',
    projectDir: '-home-user-workspace',
    cwd: '/home/user/workspace',
    entrypoint: 'sdk-cli',
    firstPrompt: 'hi',
    firstTs: '2026-04-23T11:50:54.755Z',
    lastModified: '2026-04-23T12:08:38.563Z',
    sizeBytes: 2048,
    inBot: true,
  },
  {
    uuid: 'bbbb2222-3333-4444-5555-666677778888',
    projectDir: '-tmp-fake-refactor-task',
    cwd: '/tmp/fake-refactor-task',
    entrypoint: 'cli',
    firstPrompt: '我想重构这个 handler 模块,看你建议怎么做',
    firstTs: '2026-04-27T03:53:33.000Z',
    lastModified: '2026-04-27T03:53:33.000Z',
    sizeBytes: 989,
    inBot: false,
  },
  {
    uuid: 'cccc1111-2222-3333-4444-555555555555',
    projectDir: '-Users-someone-projects-foo',
    cwd: '/Users/someone/projects/foo',
    entrypoint: 'vscode',
    firstPrompt: 'add typescript types to this js file',
    firstTs: '2026-04-26T10:15:00.000Z',
    lastModified: '2026-04-26T11:42:00.000Z',
    sizeBytes: 1024 * 1024 * 4 + 200_000,
    inBot: false,
  },
  {
    uuid: 'dddd9999-aaaa-bbbb-cccc-ddddeeeeffff',
    projectDir: '-home-user-workspace',
    cwd: '/home/user/workspace',
    entrypoint: 'sdk-cli',
    firstPrompt: '用一句友好简短的中文跟我打个招呼，不要太长。',
    firstTs: '2026-04-28T01:00:00.000Z',
    lastModified: '2026-04-28T01:00:05.000Z',
    sizeBytes: 1234,
    inBot: false,
    scheduleName: 'say hello',
  },
]

export const mockMessages: UiMessage[] = [
  {
    role: 'user',
    text: 'hi',
    timestamp: '2026-04-23T11:50:54.755Z',
    uuid: 'fa739541-f40d-425b-a890-ac1a28c07d2c',
  },
  {
    role: 'assistant',
    text: '你好！有什么可以帮你的吗？',
    timestamp: '2026-04-23T11:50:57.987Z',
    uuid: '31801e32-ae26-4902-95aa-58b61f887c2f',
  },
  {
    role: 'user',
    text: '1+1 给个数字答案就够了',
    timestamp: '2026-04-23T12:08:34.144Z',
    uuid: '5f025ba3-05ef-4966-a599-cc2868b67fa4',
  },
  {
    role: 'assistant',
    text: '2',
    timestamp: '2026-04-23T12:08:38.563Z',
    uuid: '1cc3a313-1185-4260-8c03-7b9a5ceb2a75',
  },
]

export const mockMessagesWithError: UiMessage[] = [
  {
    role: 'user',
    text: 'help me write a python http server',
    timestamp: '2026-04-23T10:30:00.000Z',
    uuid: 'aaaa-bbbb-cccc-dddd-1',
  },
  {
    role: 'assistant',
    text: 'Failed to authenticate. API Error: 403 {"error":{"type":"forbidden","message":"Request not allowed"}}',
    timestamp: '2026-04-23T10:30:03.000Z',
    uuid: 'aaaa-bbbb-cccc-dddd-2',
    isError: true,
  },
]

export const mockConfigEmpty: ConfigResponse = {
  path: '/home/user/.config/clawx/config.json',
  config: {
    larkAppSecret: { preview: '', set: false },
  },
}

export const mockConfigPartial: ConfigResponse = {
  path: '/home/user/.config/clawx/config.json',
  config: {
    claudeCwd: '/home/user/workspace',
    claudeCmd: 'claude',
    larkAppSecret: { preview: '', set: false },
  },
}

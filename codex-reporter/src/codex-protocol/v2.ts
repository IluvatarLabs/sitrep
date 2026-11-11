// Codex app-server protocol types this reporter uses, vendored from the generator Codex ships:
//
//   <managedCodexPath> app-server generate-ts --experimental --out <dir>
//
// run with the managed daemon's binary (`codex app-server daemon version` → managedCodexPath), app-server 0.164.0.
// Definitions are the generated ones with imports removed. Three kinds of narrowing, each marked where it applies:
// - "subset": a large generated object keeps only the fields the reporter reads (the wire carries more);
// - "unknown": a nested generated type the reporter never inspects is typed `unknown` instead of vendoring its graph;
// - "sendable": a request the reporter sends keeps only the fields it may send (no overrides), so a field
//   beyond them is a compile error, not a review finding.
// Machines run different Codex versions, so every value read from the daemon is still checked at run time.

export type RequestId = string | number;

export type JsonValue = number | string | boolean | Array<JsonValue> | { [key in string]?: JsonValue } | null;

export type AbsolutePathBuf = string;

export type LegacyAppPathString = string;

export type ByteRange = { start: number; end: number };

// ---- initialize ------------------------------------------------------------------------------

export type ClientInfo = { name: string; title: string | null; version: string };

export type InitializeCapabilities = {
  explicitGatewayOauth?: boolean;
  /** Opt into receiving experimental API methods and fields. */
  experimentalApi: boolean;
  /** Opt into `attestation/generate` requests for upstream `x-oai-attestation`. */
  requestAttestation: boolean;
  mcpServerOpenaiFormElicitation?: boolean;
  optOutNotificationMethods?: Array<string> | null;
  extensions?: { [key in string]?: JsonValue } | null;
};

export type InitializeParams = { clientInfo: ClientInfo; capabilities: InitializeCapabilities | null };

export type InitializeResponse = { userAgent: string; codexHome: AbsolutePathBuf; platformFamily: string; platformOs: string };

// ---- threads ---------------------------------------------------------------------------------

export type ThreadActiveFlag = 'waitingOnApproval' | 'waitingOnUserInput';

export type ThreadStatus = { type: 'notLoaded' } | { type: 'idle' } | { type: 'systemError' } | { type: 'active'; activeFlags: Array<ThreadActiveFlag> };

export type ThreadHistoryMode = 'legacy' | 'paginated';

export type ReasoningEffort = string;

export type SubAgentSource =
  | 'review'
  | 'compact'
  | { thread_spawn: { parent_thread_id: string; depth: number; agent_path: string | null; agent_nickname: string | null; agent_role: string | null } }
  | 'memory_consolidation'
  | { other: string };

export type SessionSource = 'cli' | 'vscode' | 'exec' | 'appServer' | { custom: string } | { subAgent: SubAgentSource } | 'unknown';

/** Subset of the generated `Thread`. */
export type Thread = {
  id: string;
  /** Session id shared by threads that belong to the same session tree. */
  sessionId: string;
  /** The ID of the parent thread. This will only be set if this thread is a subagent. */
  parentThreadId: string | null;
  /** Whether the thread is ephemeral and should not be materialized on disk. */
  ephemeral: boolean;
  historyMode: ThreadHistoryMode;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  /** Unix timestamp (in seconds) when the thread was created. */
  createdAt: number;
  status: ThreadStatus;
  /** [UNSTABLE] Path to the thread on disk. */
  path: string | null;
  cwd: AbsolutePathBuf;
  cliVersion: string;
  source: SessionSource;
  agentNickname: string | null;
  agentRole: string | null;
  /** Optional user-facing thread title. */
  name: string | null;
};

export type ThreadStartedNotification = { thread: Thread };

export type ThreadStatusChangedNotification = { threadId: string; status: ThreadStatus };

export type ThreadClosedNotification = { threadId: string };

export type ThreadNameUpdatedNotification = { threadId: string; threadName?: string };

export type ServerRequestResolvedNotification = { threadId: string; requestId: RequestId };

export type ThreadLoadedListParams = { cursor?: string | null; limit?: number | null };

export type ThreadLoadedListResponse = { data: Array<string>; nextCursor: string | null };

export type ThreadReadParams = { threadId: string; includeTurns?: boolean };

/** Subset: `readState` is unknown. */
export type ThreadReadResponse = { thread: Thread; readState: unknown };

/** Sendable: `thread/resume` with nothing but the thread and `excludeTurns`. */
export type ThreadResumeParams = { threadId: string; excludeTurns: true };

/** Subset. */
export type ThreadResumeResponse = { thread: Thread };

export type ThreadUnsubscribeParams = { threadId: string };

export type ThreadUnsubscribeStatus = 'notLoaded' | 'notSubscribed' | 'unsubscribed';

export type ThreadUnsubscribeResponse = { status: ThreadUnsubscribeStatus };

export type TextElement = { byteRange: ByteRange; placeholder: string | null };

/** Sendable: the `text` variant of the generated `UserInput` union only. */
export type UserInput = { type: 'text'; text: string; text_elements: Array<TextElement> };

/** Sendable: `turn/start` with nothing but the thread and the input. */
export type TurnStartParams = { threadId: string; input: Array<UserInput> };

/** Sendable: `turn/steer` with the thread, the active turn it must still be, and the input only. */
export type TurnSteerParams = { threadId: string; expectedTurnId: string; input: Array<UserInput> };

export type ThreadCompactStartParams = { threadId: string };

// ---- hooks -----------------------------------------------------------------------------------

export type HooksListParams = { cwds?: Array<string> };

export type HookEventName =
  | 'preModelRequest'
  | 'postModelRequest'
  | 'preToolUse'
  | 'permissionRequest'
  | 'postToolUse'
  | 'preCompact'
  | 'postCompact'
  | 'sessionStart'
  | 'sessionEnd'
  | 'userPromptSubmit'
  | 'subagentStart'
  | 'subagentStop'
  | 'stop'
  | 'interrupt';

export type HookTrustStatus = 'managed' | 'untrusted' | 'trusted' | 'modified';

export type HookSource =
  | 'system'
  | 'user'
  | 'project'
  | 'mdm'
  | 'sessionFlags'
  | 'plugin'
  | 'cloudRequirements'
  | 'cloudManagedConfig'
  | 'legacyManagedConfigFile'
  | 'legacyManagedConfigMdm'
  | 'unknown';

/** Subset of the generated `HookMetadata`. */
export type HookMetadata = {
  key: string;
  eventName: HookEventName;
  source: HookSource;
  pluginId: string | null;
  enabled: boolean;
  trustStatus: HookTrustStatus;
} & ({ handlerType: 'command'; command: string; async: boolean } | { handlerType: 'mcpTool' } | { handlerType: 'prompt' } | { handlerType: 'agent' });

export type HookErrorInfo = { path: string; message: string };

export type HooksListEntry = { cwd: string; hooks: Array<HookMetadata>; warnings: Array<string>; errors: Array<HookErrorInfo> };

export type HooksListResponse = { data: Array<HooksListEntry> };

// ---- server requests the reporter maps --------------------------------------------------------

export type CommandExecutionApprovalKind = 'command' | 'writeStdin';

export type NetworkApprovalProtocol = 'http' | 'https' | 'socks5Tcp' | 'socks5Udp';

export type NetworkApprovalContext = { host: string; protocol: NetworkApprovalProtocol };

export type ExecPolicyAmendment = Array<string>;

export type NetworkPolicyRuleAction = 'allow' | 'deny';

export type NetworkPolicyAmendment = { host: string; action: NetworkPolicyRuleAction };

export type CommandExecutionApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: ExecPolicyAmendment } }
  | { applyNetworkPolicyAmendment: { network_policy_amendment: NetworkPolicyAmendment } }
  | 'decline'
  | 'cancel';

/** `commandActions` and `additionalPermissions` (an AdditionalPermissionProfile) are unknown. */
export type CommandExecutionRequestApprovalParams = {
  kind: CommandExecutionApprovalKind;
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs: number;
  approvalId?: string | null;
  environmentId: string | null;
  reason?: string | null;
  networkApprovalContext?: NetworkApprovalContext | null;
  command?: string | null;
  cwd?: LegacyAppPathString | null;
  commandActions?: unknown;
  additionalPermissions?: unknown;
  proposedExecpolicyAmendment?: ExecPolicyAmendment | null;
  proposedNetworkPolicyAmendments?: Array<NetworkPolicyAmendment> | null;
  /** Ordered list of decisions the client may present for this prompt. */
  availableDecisions?: Array<CommandExecutionApprovalDecision> | null;
};

export type CommandExecutionRequestApprovalResponse = { decision: CommandExecutionApprovalDecision };

export type FileChangeRequestApprovalParams = {
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs: number;
  reason?: string | null;
  /** [UNSTABLE] When set, the agent is asking the user to allow writes under this root for the remainder of the session. */
  grantRoot?: string | null;
};

export type FileChangeApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export type FileChangeRequestApprovalResponse = { decision: FileChangeApprovalDecision };

export type AdditionalNetworkPermissions = { enabled: boolean | null };

/** `entries` (FileSystemSandboxEntry[]) is unknown. */
export type AdditionalFileSystemPermissions = {
  read: Array<LegacyAppPathString> | null;
  write: Array<LegacyAppPathString> | null;
  globScanMaxDepth?: number;
  entries?: Array<unknown>;
};

export type RequestPermissionProfile = { network: AdditionalNetworkPermissions | null; fileSystem: AdditionalFileSystemPermissions | null };

export type GrantedPermissionProfile = { network?: AdditionalNetworkPermissions; fileSystem?: AdditionalFileSystemPermissions };

export type PermissionGrantScope = 'turn' | 'session';

export type PermissionsRequestApprovalParams = {
  threadId: string;
  turnId: string;
  itemId: string;
  environmentId: string | null;
  startedAtMs: number;
  cwd: LegacyAppPathString;
  reason: string | null;
  permissions: RequestPermissionProfile;
};

/** Sendable: no `strictAutoReview`. */
export type PermissionsRequestApprovalResponse = { permissions: GrantedPermissionProfile; scope: PermissionGrantScope };

export type ToolRequestUserInputOption = { label: string; description: string };

export type ToolRequestUserInputQuestion = { id: string; header: string; question: string; isOther: boolean; isSecret: boolean; options: Array<ToolRequestUserInputOption> | null };

export type ToolRequestUserInputParams = { threadId: string; turnId: string; itemId: string; questions: Array<ToolRequestUserInputQuestion>; isBlocking: boolean; autoResolutionMs: number | null };

export type ToolRequestUserInputAnswer = { answers: Array<string> };

export type ToolRequestUserInputResponse = { answers: { [key in string]?: ToolRequestUserInputAnswer } };

/** The server-request methods of the generated `ServerRequest` union. Only the first four are mapped; the rest are ignored. */
export type ServerRequestMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/tool/requestUserInput'
  | 'item/permissions/requestApproval'
  | 'mcpServer/elicitation/request'
  | 'item/tool/call'
  | 'account/chatgptAuthTokens/refresh'
  | 'attestation/generate'
  | 'currentTime/read'
  | 'applyPatchApproval'
  | 'execCommandApproval';

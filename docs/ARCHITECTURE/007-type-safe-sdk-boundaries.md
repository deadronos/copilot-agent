# ADR 007: Type-Safe SDK Boundaries (Refactor)

**Status:** Accepted  
**Date:** 2026-06-04  
**Deciders:** @deadronos

## Context

The initial implementation (`c241b2e`) used `any` casts at the Copilot SDK boundary to access fields and call methods that weren't properly typed. Specifically:

- `onPermissionRequest` used `(request as any).toolName` and `(request as any).fullCommandText` to access variant-specific fields
- Session archiving called `(session as any).getMessages?.()` — a method that doesn't exist on `CopilotSession`
- The `handlePermissionRequest` return type was `Promise<{ kind: string }>` instead of the SDK's `PermissionRequestResult`
- The `deny-all` branch returned `{ kind: 'denied' }` which didn't match the SDK's expected shape
- `pendingPermissions` map value type in `TelegramBot` lacked a `toolName` field, requiring `as any` casts in the callback handler

These `any` casts defeated TypeScript's type checking and hid real bugs (empty archives, wrong return shapes).

## Decision

**Replace all `any` casts at the SDK boundary with the real exported SDK types (`PermissionRequest`, `PermissionRequestResult`) and use discriminated unions for variant narrowing.**

Key changes:

### 1. Typed `onPermissionRequest` callback
```typescript
// Before (any casts)
onPermissionRequest: (request: any, _invocation: any) => {
  const toolName = request.toolName ?? request.kind;
  const description = request.fullCommandText ?? request.fileName ?? '';
  return this.handlePermissionRequest(chatId, toolName, description, request.toolCallId);
}

// After (discriminated union narrowing)
onPermissionRequest: (
  request: PermissionRequest,
  _invocation: { sessionId: string },
): Promise<PermissionRequestResult> => {
  const toolName = 'toolName' in request ? request.toolName : request.kind;
  const description = 'fullCommandText' in request
    ? request.fullCommandText
    : 'fileName' in request ? request.fileName : '';
  return this.handlePermissionRequest(chatId, toolName, description, request.toolCallId);
}
```

`PermissionRequest` is a discriminated union where different tool types have different fields. Using `'toolName' in request` narrowing is the correct TypeScript pattern for accessing variant-specific fields without `any`.

### 2. Correct `deny-all` return shape
```typescript
// Before
return { kind: 'denied' as any };

// After
return { kind: 'denied-by-rules' as const, rules: [] };
```

The SDK's `PermissionRequestResult` has a `denied-by-rules` variant that requires a `rules` array. The app-level "deny all" rule lives in `config.permissions.mode`, not the SDK's per-tool rule registry, so we pass an empty `rules` array.

### 3. Real `getEvents()` instead of fake `getMessages()`
```typescript
// Before — silently returns undefined (method doesn't exist)
const messages = await (session as any).getMessages?.();

// After — uses the actual SDK API
const events = await session.getEvents();
const archive: ArchivedSession = {
  messages: events.flatMap((e) => {
    switch (e.type) {
      case 'assistant.message': return [{ role: 'assistant', content: e.data.content, timestamp }];
      case 'user.message': return [{ role: 'user', content: e.data.content, timestamp }];
      default: return [];
    }
  }),
};
```

The `getMessages()` method didn't exist on `CopilotSession`, so `(session as any).getMessages?.()` always returned `undefined`. Archives were always empty. `getEvents()` is the real API and now archives contain actual message history.

### 4. Typed `pendingPermissions` map
```typescript
// Before
private pendingPermissions = new Map<string, {
  chatId: number;
  resolve: (decision: PermissionDecision) => void;
  messageId: number;
}>();

// After — includes toolName
private pendingPermissions = new Map<string, {
  chatId: number;
  resolve: (decision: PermissionDecision) => void;
  messageId: number;
  toolName: string;
}>();
```

Adding `toolName` to the map value type eliminated two `as any` casts in the permission callback handler, where `pending.toolName` was being accessed but not declared in the type.

### 5. Drop dead code
- Unused `createPermissionRequest` import in `sessions.ts`
- Unused `entry` in `resumeSession`
- Unused `InlineKeyboard` import in `telegram.ts`
- Unused `chatId` in `handleStart`

## Rationale

1. **Type safety catches bugs before runtime.** `(session as any).getMessages?.()` was always returning `undefined` — TypeScript couldn't warn us because we bypassed the type system. Now `session.getEvents()` is correctly typed and verified by the compiler.
2. **Discriminated unions are idiomatic TypeScript.** `'toolName' in request` is the standard pattern for narrowing union types. It tells TypeScript (and readers) which variant we're handling.
3. **The linter enforces this.** ESLint's `@typescript-eslint/no-explicit-any` rule (enabled by default) would flag any new `any` casts. Combined with `consistent-type-imports`, the codebase stays typed.
4. **Archives now work.** This was a real bug — `/resume` was replaying empty history because archives were never populated. The fix isn't just type safety; it's correct behavior.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Keep `any` casts with comments | Doesn't fix the bug. `getMessages()` still doesn't exist; archives still empty. |
| Type guards in a separate file | Adds indirection. The discriminated union narrowing is simple enough to inline at the call site. |
| Escape hatches via `// @ts-expect-error` | Defeats the purpose. If the SDK API changes, we _want_ the compiler to tell us. |

## Consequences

### Positive
- All SDK interactions are now correctly typed
- The compiler catches breaking changes in the SDK API
- Session archives contain real message history (bug fix)
- Dead imports and unused variables are removed
- Future contributors cannot silently introduce `any` casts (lint rule)

### Negative
- Discriminated union narrowing adds verbosity compared to `any` casts
- The `PermissionRequest` union must be manually kept in sync with the SDK (if the SDK adds new tool types, our narrowing may need updates)

### Mitigations
- The SDK types are third-party — if they change, the compiler will error at the call sites, which is the desired behavior
- ESLint's `no-explicit-any` prevents regression to `any` casts
- The refactored code was verified with `npm run typecheck` (clean) and `npm test` (12/12 passing)

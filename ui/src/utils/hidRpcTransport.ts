import type { RpcMessage } from "@/hooks/hidRpc";

export interface HidRpcSendChannel {
  readyState: string;
  send: (data: ArrayBuffer) => void;
}

export interface HidRpcTransportChannels {
  reliable: HidRpcSendChannel | null | undefined;
  unreliableOrdered?: HidRpcSendChannel | null | undefined;
  unreliableNonOrdered?: HidRpcSendChannel | null | undefined;
}

export interface HidRpcTransportState {
  hidRpcDisabled?: boolean;
  handshakeReady: boolean;
  unreliableOrderedReady: boolean;
  unreliableNonOrderedReady: boolean;
}

export interface HidRpcSendMessageParams {
  ignoreHandshakeState?: boolean;
  useUnreliableChannel?: boolean;
  requireOrdered?: boolean;
}

export interface HidRpcTransportLogger {
  error: (message: string, error: unknown) => void;
}

function isOpen(channel: HidRpcSendChannel | null | undefined): channel is HidRpcSendChannel {
  return channel?.readyState === "open";
}

export function sendHidRpcMessage(
  message: RpcMessage,
  channels: HidRpcTransportChannels,
  state: HidRpcTransportState,
  {
    ignoreHandshakeState,
    useUnreliableChannel,
    requireOrdered = true,
  }: HidRpcSendMessageParams = {},
  logger?: HidRpcTransportLogger,
): boolean {
  if (state.hidRpcDisabled) return false;
  if (!isOpen(channels.reliable)) return false;
  if (!state.handshakeReady && !ignoreHandshakeState) return false;

  let data: Uint8Array | undefined;
  try {
    data = message.marshal();
  } catch (e) {
    logger?.error("Failed to marshal message", e);
  }
  if (!data) return false;

  if (useUnreliableChannel) {
    const preferredUnreliable =
      requireOrdered && state.unreliableOrderedReady
        ? channels.unreliableOrdered
        : !requireOrdered && state.unreliableNonOrderedReady
          ? channels.unreliableNonOrdered
          : null;

    if (isOpen(preferredUnreliable)) {
      preferredUnreliable.send(data as unknown as ArrayBuffer);
      return true;
    }
  }

  channels.reliable.send(data as unknown as ArrayBuffer);
  return true;
}

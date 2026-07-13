export interface AutomationChannelPublicationState {
  readonly connected: boolean;
  readonly rpcOpen: boolean;
  readonly hidOpen: boolean;
  readonly hidDisabled: boolean;
  readonly hidProtocolVersion: number | null;
  readonly forceUnavailable: boolean;
}

export function shouldPublishAutomationChannels(state: AutomationChannelPublicationState): boolean {
  if (state.forceUnavailable) return true;
  if (!state.connected || !state.rpcOpen) return false;
  return state.hidDisabled || (state.hidOpen && state.hidProtocolVersion !== null);
}

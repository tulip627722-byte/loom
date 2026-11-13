export interface ConnectorStatus {
  id: string;
  connected: boolean;
  displayName: string;
  capabilities: string[];
}

export const phaseTwoConnectors: ConnectorStatus[] = [
  { id: 'github', connected: false, displayName: 'GitHub', capabilities: ['repositories', 'issues', 'pull-requests', 'actions', 'releases'] },
  { id: 'feishu', connected: false, displayName: '飞书', capabilities: ['bot', 'approvals', 'documents', 'wiki'] },
];

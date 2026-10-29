/** Human approvals are distinct from questions and workflow phases. */
export type SessionApprovalType = 'permission' | 'plan_approval' | 'git_commit';

export interface PendingSessionApproval {
  sessionId: string;
  requestId: string;
  type: SessionApprovalType;
}

export interface SessionApprovalSnapshot {
  revision: number;
  approvals: PendingSessionApproval[];
}

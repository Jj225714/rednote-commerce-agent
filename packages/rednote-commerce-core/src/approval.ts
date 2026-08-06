import { createHash } from 'node:crypto';

import type { ApprovalProposal, RednoteApproval } from './types.js';

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashStableValue(value: unknown): string {
  const text = stableSerialize(value);
  return `sha256-${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

export function hashApprovalProposal(proposal: ApprovalProposal): string {
  return hashStableValue(proposal);
}

export function expireApprovalIfNeeded(
  approval: RednoteApproval,
  now: Date,
): RednoteApproval {
  if (approval.status !== 'pending' || new Date(approval.expiresAt).getTime() > now.getTime()) {
    return approval;
  }
  return {
    ...approval,
    status: 'expired',
    decidedAt: approval.expiresAt,
    decisionReason: '审批已过期',
  };
}

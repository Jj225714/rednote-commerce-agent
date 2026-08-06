export type RednoteDomainErrorCode =
  | 'INVALID_STATE'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_ALREADY_PENDING'
  | 'APPROVAL_NOT_PENDING'
  | 'PROPOSAL_CHANGED';

export class RednoteDomainError extends Error {
  readonly code: RednoteDomainErrorCode;

  constructor(code: RednoteDomainErrorCode, message: string) {
    super(message);
    this.name = 'RednoteDomainError';
    this.code = code;
  }
}

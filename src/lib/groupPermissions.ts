import { GroupMemberRole } from "@prisma/client";

/** Quem pode adicionar atleta ao grupo pelo telefone (regra do produto). */
export const GROUP_INVITER_ROLES: GroupMemberRole[] = [
  GroupMemberRole.PRESIDENT,
  GroupMemberRole.VICE_PRESIDENT,
  GroupMemberRole.TREASURER,
];

export function canInviteByPhone(role: GroupMemberRole): boolean {
  return GROUP_INVITER_ROLES.includes(role);
}

/** Quem pode aprovar ou recusar inscrição em grupo público. */
export const JOIN_APPROVER_ROLES: GroupMemberRole[] = [
  GroupMemberRole.PRESIDENT,
  GroupMemberRole.VICE_PRESIDENT,
  GroupMemberRole.TREASURER,
  GroupMemberRole.MODERATOR,
];

export function canApproveJoinRequests(role: GroupMemberRole): boolean {
  return JOIN_APPROVER_ROLES.includes(role);
}

/** Quem pode marcar mensalidade como paga ou em aberto (tesouraria). */
export const MONTHLY_FEE_MANAGER_ROLES: GroupMemberRole[] = [
  GroupMemberRole.PRESIDENT,
  GroupMemberRole.VICE_PRESIDENT,
  GroupMemberRole.TREASURER,
];

export function canManageMonthlyFees(role: GroupMemberRole): boolean {
  return MONTHLY_FEE_MANAGER_ROLES.includes(role);
}

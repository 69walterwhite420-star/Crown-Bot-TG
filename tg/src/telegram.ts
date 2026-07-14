// The narrow slice of the Bot API the service uses — an interface, so the
// integration tests replace it with a recorder. Kicking is ban+unban: the
// account may re-apply later (a kick is enforcement, not a curse).

export interface TelegramApi {
  sendMessage(chatId: bigint, text: string): Promise<void>;
  approveJoinRequest(chatId: bigint, userId: bigint): Promise<void>;
  kickMember(chatId: bigint, userId: bigint): Promise<void>;
  /** A request-to-join invite link of the channel — the member's door. */
  createInviteLink(chatId: bigint): Promise<string>;
}

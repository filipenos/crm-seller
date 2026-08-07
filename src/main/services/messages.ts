import { getDb } from '../db'
import type { ChatMessage, Conversation } from '@shared/types'

interface ConversationRow {
  conversation_id: string
  buyer_username: string
  buyer_avatar: string | null
  last_message_at: number | null
  last_message_preview: string | null
  unread_count: number
}

interface MessageRow {
  message_id: string
  conversation_id: string
  order_sn: string | null
  direction: 'in' | 'out'
  content_type: string
  content: string
  image_url: string | null
  created_at: number
}

function rowToConversation(r: ConversationRow): Conversation {
  return {
    conversationId: r.conversation_id,
    buyerUsername: r.buyer_username,
    buyerAvatar: r.buyer_avatar,
    lastMessageAt: r.last_message_at,
    lastMessagePreview: r.last_message_preview,
    unreadCount: r.unread_count
  }
}

function rowToMessage(r: MessageRow): ChatMessage {
  return {
    messageId: r.message_id,
    conversationId: r.conversation_id,
    orderSn: r.order_sn,
    direction: r.direction,
    contentType: r.content_type,
    content: r.content,
    imageUrl: r.image_url,
    createdAt: r.created_at
  }
}

export function listConversations(): Conversation[] {
  const rows = getDb()
    .prepare('SELECT * FROM conversations ORDER BY last_message_at DESC')
    .all() as ConversationRow[]
  return rows.map(rowToConversation)
}

export function listMessagesByConversation(conversationId: string): ChatMessage[] {
  const rows = getDb()
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
    .all(conversationId) as MessageRow[]
  return rows.map(rowToMessage)
}

/**
 * Mensagens relacionadas a um pedido: as marcadas com o order_sn e também
 * todas as conversas do comprador do pedido (o nome da criança costuma vir
 * em mensagem avulsa, não anexada ao pedido).
 */
export function listMessagesForOrder(orderSn: string): ChatMessage[] {
  const db = getDb()
  const order = db
    .prepare('SELECT buyer_username FROM orders WHERE order_sn = ?')
    .get(orderSn) as { buyer_username: string | null } | undefined

  const rows = db
    .prepare(
      `SELECT DISTINCT m.* FROM messages m
       LEFT JOIN conversations c ON c.conversation_id = m.conversation_id
       WHERE m.order_sn = ? OR (? IS NOT NULL AND c.buyer_username = ?)
       ORDER BY m.created_at ASC`
    )
    .all(orderSn, order?.buyer_username ?? null, order?.buyer_username ?? null) as MessageRow[]
  return rows.map(rowToMessage)
}

export interface UpsertConversationInput {
  conversationId: string
  buyerUsername: string
  buyerAvatar?: string | null
  lastMessageAt?: number | null
  lastMessagePreview?: string | null
  unreadCount?: number
  rawJson?: string
}

export function upsertConversation(input: UpsertConversationInput): void {
  getDb()
    .prepare(
      `INSERT INTO conversations (conversation_id, buyer_username, buyer_avatar, last_message_at, last_message_preview, unread_count, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         buyer_username = excluded.buyer_username,
         buyer_avatar = COALESCE(excluded.buyer_avatar, conversations.buyer_avatar),
         last_message_at = COALESCE(excluded.last_message_at, conversations.last_message_at),
         last_message_preview = COALESCE(excluded.last_message_preview, conversations.last_message_preview),
         unread_count = excluded.unread_count,
         raw_json = COALESCE(excluded.raw_json, conversations.raw_json)`
    )
    .run(
      input.conversationId,
      input.buyerUsername,
      input.buyerAvatar ?? null,
      input.lastMessageAt ?? null,
      input.lastMessagePreview ?? null,
      input.unreadCount ?? 0,
      input.rawJson ?? null
    )
}

export interface UpsertMessageInput {
  messageId: string
  conversationId: string
  orderSn?: string | null
  direction: 'in' | 'out'
  contentType: string
  content: string
  imageUrl?: string | null
  createdAt: number
  rawJson?: string
}

/** Retorna true se a mensagem é nova. */
export function upsertMessage(input: UpsertMessageInput): boolean {
  const result = getDb()
    .prepare(
      `INSERT INTO messages (message_id, conversation_id, order_sn, direction, content_type, content, image_url, created_at, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         order_sn = COALESCE(excluded.order_sn, messages.order_sn),
         content = excluded.content,
         image_url = COALESCE(excluded.image_url, messages.image_url)`
    )
    .run(
      input.messageId,
      input.conversationId,
      input.orderSn ?? null,
      input.direction,
      input.contentType,
      input.content,
      input.imageUrl ?? null,
      input.createdAt,
      input.rawJson ?? null
    )
  return result.lastInsertRowid !== undefined && result.changes > 0
}

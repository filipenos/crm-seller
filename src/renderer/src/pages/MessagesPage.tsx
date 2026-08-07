import { useEffect, useState } from 'react'
import type { ChatMessage, Conversation } from '@shared/types'

interface Props {
  dataVersion: number
}

export default function MessagesPage({ dataVersion }: Props): React.JSX.Element {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])

  useEffect(() => {
    void window.api.messages.conversations().then(setConversations)
  }, [dataVersion])

  useEffect(() => {
    if (selected) {
      void window.api.messages.byConversation(selected).then(setMessages)
    } else {
      setMessages([])
    }
  }, [selected, dataVersion])

  return (
    <div className="page messages-page">
      <div className="conv-list">
        <header className="page-header">
          <h1>Mensagens</h1>
        </header>
        {conversations.length === 0 && (
          <div className="empty">Nenhuma conversa sincronizada ainda.</div>
        )}
        {conversations.map((c) => (
          <button
            key={c.conversationId}
            className={`conv-item ${selected === c.conversationId ? 'active' : ''}`}
            onClick={() => setSelected(c.conversationId)}
          >
            <div className="conv-name">
              {c.buyerUsername}
              {c.unreadCount > 0 && <span className="unread">{c.unreadCount}</span>}
            </div>
            <div className="conv-preview">{c.lastMessagePreview ?? ''}</div>
            {c.lastMessageAt && (
              <div className="conv-time">
                {new Date(c.lastMessageAt).toLocaleString('pt-BR')}
              </div>
            )}
          </button>
        ))}
      </div>
      <div className="conv-thread">
        {!selected ? (
          <div className="empty">Selecione uma conversa.</div>
        ) : (
          <div className="chat">
            {messages.map((m) => (
              <div key={m.messageId} className={`chat-msg ${m.direction}`}>
                <div className="chat-content">
                  {m.content}
                  {m.imageUrl && <img src={m.imageUrl} alt="" className="chat-img" />}
                </div>
                <div className="chat-meta">
                  {new Date(m.createdAt).toLocaleString('pt-BR')}
                  {m.orderSn && <span className="mono"> · pedido {m.orderSn}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

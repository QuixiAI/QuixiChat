import type { Message } from '@quixi/core/model';

export function MessageTimestamp({ message }: { message: Pick<Message, 'createdAt' | 'recordedAt'> }) {
  const date = new Date(message.createdAt ?? message.recordedAt);
  if (!Number.isFinite(date.getTime())) return <small className="message-timestamp">Time unavailable</small>;
  return <time className="message-timestamp" dateTime={date.toISOString()}>
    {message.createdAt === null ? 'Recorded ' : ''}{date.toLocaleString()}
  </time>;
}

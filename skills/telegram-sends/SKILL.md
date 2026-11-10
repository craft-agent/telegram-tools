---
name: telegram-sends
description: 'Use when sending, replying to or posting a message in Telegram, writing to a person, a group, a forum topic or Saved Messages, or when the user says "send this to …".'
---

# Sending messages

| Tool                    | Does                                         | Writes |
| ----------------------- | -------------------------------------------- | ------ |
| `telegram_message_send` | sends one text to a chat, optionally a reply | yes    |

## Finding the chat

- `chat` is a chat id from `telegram_chat_read` (`list`, `view` or `topics`).
  Never use a chat name, a username or a phone number.
- Saved Messages is the user's own chat (`kind: "self"`). It is a safe place to
  try a send.
- `topic` is a forum topic's id from `telegram_chat_read` `topics`; 1 is
  General.
- `reply_to` is the id of a message in that same chat.

## The text

- Send what the user asked for, as written. Do not rephrase it, translate it,
  add Markdown (it is not parsed) or sign it.
- Surrounding blank space is trimmed. The text is at most 4096 characters; split
  a longer one into several sends only if the user agrees.

## What it needs

- The sync service must be running: the call goes out through it.
- A result means Telegram accepted the message, not that anyone has read it.

## Failures

Nothing was sent in any of these:

- `forbidden`: the user left the chat, cannot write there, the topic is closed
  or the person blocked them. Tell the user.
- `not_found`: the chat, the topic or the message replied to does not exist.
  Check the ids again with `telegram_chat_read`.
- `rate_limited`: wait the seconds the error gives, and never retry sooner.
- `invalid_argument`: fix the argument the error names.

## When it may have gone out

`uncertain` means the message may have been sent. Tell the user, and show the
messages the error lists in `details.sent_like_this` (or say that none was seen
yet). Ask them to check the chat in Telegram. Never send it again unless they
confirm it did not arrive.

`duplicate: true` means it went out once: do not send it again.

## Not here yet

Sending files is `telegram_file_send` in the `files` toolset (off by default;
see `telegram-files`). Actions on messages already sent are separate tools that
are not part of this one.

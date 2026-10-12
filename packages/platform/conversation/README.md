# @0xnullai/conversation

Read-only projection for one account-owned chat window. It does not store messages, authorize
attachments, send messages, run tools, or change the Chat DO and Auth conversation owners.

`ConversationView` groups a conversation's timeline and composer capabilities. `TimelineItem`
distinguishes human and AI messages, system events, voice transcripts, camera observations, and
media jobs. Adapters retain source order and mark Chat messages without a server acknowledgement as
pending. AI message and attachment adapters accept only records returned by the account-bound server
clients; callers must not pass optimistic AI drafts as confirmed history.

Attachment references identify the server object and the authorization mechanism. A reference is
not a public download URL. Chat DM playback still needs the current socket capability; private AI
attachments still need an account-bound authenticated request. The UI must revalidate those at read
time. Unknown legacy Chat object IDs remain `null` rather than being guessed from a URL.

Server sequence is the preferred order key. Legacy Chat lists preserve their authoritative list
order; timestamps are display-only. Media jobs can supply `afterSequence` so the shared sorter
places their cards immediately after a known message, with stable ID tie-breaking.

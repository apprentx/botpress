'use strict'

if (event.type === 'introduction-script') {
  const eventDestination = {
    channel: event.channel,
    target: event.target,
    botId: event.botId,
    threadId: event.threadId // Skip event processing
  }
  event.setFlag(bp.IO.WellKnownFlags.SKIP_DIALOG_ENGINE, true) // Make the bot respond with custom content instead

  const sessionId = bp.dialog.createId(event)
  await bp.dialog.jumpTo(sessionId, event, 'introduction.flow.json', 'entry')
}

import { createMessageAdapter } from '@slack/interactive-messages'
import { RTMClient } from '@slack/rtm-api'
import { WebClient } from '@slack/web-api'
import axios from 'axios'
import * as sdk from 'botpress/sdk'
import _ from 'lodash'

import { Config } from '../config'

import { Clients } from './typings'

const debug = DEBUG('channel-slack')
const debugIncoming = debug.sub('incoming')
const debugOutgoing = debug.sub('outgoing')

const outgoingTypes = ['text', 'image', 'actions', 'typing', 'carousel']

export class SlackClient {
  private client: WebClient
  private rtm: RTMClient
  private interactive: any
  private logger: sdk.Logger

  constructor(private bp: typeof sdk, private botId: string, private config: Config, private router) {
    this.logger = bp.logger.forBot(botId)
  }

  async initialize() {
    if (!this.config.botToken || !this.config.signingSecret) {
      return this.logger.error(
        `[${this.botId}] The bot token and the signing secret must be configured to use this channel.`
      )
    }

    this.client = new WebClient(this.config.botToken)
    this.rtm = new RTMClient(this.config.botToken)
    this.interactive = createMessageAdapter(this.config.signingSecret, {}) as any

    await this._setupInteractiveListener()
    await this._setupRealtime()
  }

  private async _setupInteractiveListener() {
    this.interactive.action({ type: 'button' }, async payload => {
      debugIncoming(`Received interactive message %o`, payload)

      const actionId = _.get(payload, 'actions[0].action_id', '')
      const label = _.get(payload, 'actions[0].text.text', '')
      const value = _.get(payload, 'actions[0].value', '')

      // Some actions (ex: open url) should be discarded
      if (!actionId.startsWith('discard_action')) {
        // Either we leave buttons displayed, we replace with the selection, or we remove it
        if (actionId.startsWith('replace_buttons')) {
          await axios.post(payload.response_url, { text: `*${label}*` })
        } else if (actionId.startsWith('remove_buttons')) {
          await axios.post(payload.response_url, { delete_original: true })
        }

        await this.sendEvent(payload, { type: 'quick_reply', text: label, payload: value })
      }
    })

    this.interactive.action({ actionId: 'option_selected' }, async payload => {
      const label = _.get(payload, 'actions[0].selected_option.text.text', '')
      const value = _.get(payload, 'actions[0].selected_option.value', '')

      //  await axios.post(payload.response_url, { text: `*${label}*` })
      await this.sendEvent(payload, { type: 'quick_reply', text: label, payload: value })
    })

    this.router.use(`/bots/${this.botId}/callback`, this.interactive.requestListener())
    const publicPath = await this.router.getPublicPath()

    // Bot ID is used twice, because slack must setup multiple listeners itself, so can't just be redirected
    this.logger.info(
      `[${this.botId}] Interactive Endpoint URL: ${publicPath.replace('BOT_ID', this.botId)}/bots/${
        this.botId
      }/callback`
    )
  }

  private async _setupRealtime() {
    const discardedSubtypes = ['bot_message', 'message_deleted', 'message_changed']
    this.rtm.on('message', async payload => {
      debugIncoming(`Received real time payload %o`, payload)

      if (!discardedSubtypes.includes(payload.subtype)) {
        await this.sendEvent(payload, { type: 'text', text: payload.text })
      }
    })

    await this.rtm.start()
  }

  async handleOutgoingEvent(event: sdk.IO.Event, next: sdk.IO.MiddlewareNextCallback) {
    if (event.type === 'typing') {
      await this.rtm.sendTyping(event.threadId || event.target)
      await new Promise(resolve => setTimeout(() => resolve(), 1000))

      return next(undefined, false)
    }

    const messageType = event.type === 'default' ? 'text' : event.type
    if (!_.includes(outgoingTypes, messageType)) {
      return next(new Error('Unsupported event type: ' + event.type))
    }

    const blocks = []
    if (messageType === 'image' || messageType === 'actions') {
      blocks.push(event.payload)
    } else if (messageType === 'carousel') {
      event.payload.cards.forEach(card => blocks.push(...card))
    }

    if (event.payload.quick_replies) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: event.payload.text } })
      blocks.push(event.payload.quick_replies)
    }

    const message = {
      text: event.payload.text,
      channel: event.threadId || event.target,
      blocks
    }

    debugOutgoing(`Sending message %o`, message)
    await this.client.chat.postMessage(message)

    next(undefined, false)
  }

  private async sendEvent(ctx: any, payload: any) {
    const threadId = _.get(ctx, 'channel.id') || _.get(ctx, 'channel')
    const target = _.get(ctx, 'user.id') || _.get(ctx, 'user')

    this.bp.events.sendEvent(
      this.bp.IO.Event({
        botId: this.botId,
        channel: 'slack',
        direction: 'incoming',
        payload,
        type: payload.type,
        preview: payload.text,
        threadId: threadId && threadId.toString(),
        target: target && target.toString()
      })
    )
  }
}

export async function setupMiddleware(bp: typeof sdk, clients: Clients) {
  bp.events.registerMiddleware({
    description:
      'Sends out messages that targets platform = slack.' +
      ' This middleware should be placed at the end as it swallows events once sent.',
    direction: 'outgoing',
    handler: outgoingHandler,
    name: 'slack.sendMessages',
    order: 100
  })

  async function outgoingHandler(event: sdk.IO.Event, next: sdk.IO.MiddlewareNextCallback) {
    if (event.channel !== 'slack') {
      return next()
    }

    const client: SlackClient = clients[event.botId]
    if (!client) {
      return next()
    }

    return client.handleOutgoingEvent(event, next)
  }
}

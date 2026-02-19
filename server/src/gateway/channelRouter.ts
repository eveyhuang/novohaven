import { Router } from 'express';
import { pluginRegistry } from '../plugins/registry';
import { ChannelMessage } from '../plugins/types';

export type MessageHandler = (message: ChannelMessage) => Promise<void>;

export function createChannelRouter(onMessage: MessageHandler): Router {
  const router = Router();

  // Register routes for each channel plugin and wire the message handler
  for (const [name, channel] of pluginRegistry.getAllChannels()) {
    channel.setMessageHandler(onMessage);
    const channelRouter = Router();
    channel.registerRoutes(channelRouter);
    router.use(`/${name}`, channelRouter);
    console.log(`[ChannelRouter] Mounted channel: /channels/${name}`);
  }

  return router;
}

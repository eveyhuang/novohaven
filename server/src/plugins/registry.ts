import {
  Plugin, PluginManifest,
  ChannelPlugin, ToolPlugin, MemoryPlugin, ProviderPlugin
} from './types';

class PluginRegistry {
  private channels = new Map<string, ChannelPlugin>();
  private tools = new Map<string, ToolPlugin>();
  private memory = new Map<string, MemoryPlugin>();
  private providers = new Map<string, ProviderPlugin>();
  private manifests = new Map<string, PluginManifest>();

  register(type: string, name: string, plugin: Plugin): void {
    this.manifests.set(name, plugin.manifest);
    switch (type) {
      case 'channel':
        this.channels.set(name, plugin as ChannelPlugin);
        break;
      case 'tool':
        this.tools.set(name, plugin as ToolPlugin);
        break;
      case 'memory':
        this.memory.set(name, plugin as MemoryPlugin);
        break;
      case 'provider':
        this.providers.set(name, plugin as ProviderPlugin);
        break;
      default:
        throw new Error(`Unknown plugin type: ${type}`);
    }
    console.log(`[PluginRegistry] Registered ${type} plugin: ${name}`);
  }

  getChannel(name: string): ChannelPlugin | undefined {
    return this.channels.get(name);
  }

  getTool(name: string): ToolPlugin | undefined {
    return this.tools.get(name);
  }

  getMemory(name: string): MemoryPlugin | undefined {
    return this.memory.get(name);
  }

  getProvider(name: string): ProviderPlugin | undefined {
    return this.providers.get(name);
  }

  getAllChannels(): Map<string, ChannelPlugin> { return this.channels; }
  getAllTools(): Map<string, ToolPlugin> { return this.tools; }
  getAllMemory(): Map<string, MemoryPlugin> { return this.memory; }
  getAllProviders(): Map<string, ProviderPlugin> { return this.providers; }
  getAllManifests(): Map<string, PluginManifest> { return this.manifests; }

  async shutdownAll(): Promise<void> {
    const all: Plugin[] = [
      ...this.channels.values(),
      ...this.tools.values(),
      ...this.memory.values(),
      ...this.providers.values(),
    ];
    await Promise.allSettled(all.map(p => p.shutdown()));
  }
}

// Singleton
export const pluginRegistry = new PluginRegistry();

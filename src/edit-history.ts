import type { Episode } from './types.ts';

// Assets are immutable. Checkpoints share mesh buffers instead of copying large meshes.
export function checkpoint(episode: Episode): Episode {
  return {
    manifest: structuredClone(episode.manifest),
    initial: structuredClone(episode.initial),
    states: [],
    calls: [],
    events: [],
    trajectory: [],
    observations: {},
    revision: 0,
    assets: { ...episode.assets },
  };
}

function documentKey(episode: Episode) {
  return JSON.stringify([episode.manifest, episode.initial, episode.states]);
}

export class EditHistory {
  entries: { label: string; episode: Episode }[] = [];
  index = 0;
  private savedDocument = '';
  private savedCalls = 0;
  private savedEntry: object | undefined;

  constructor(episode: Episode) {
    this.entries = [{ label: 'Initial Scene', episode: checkpoint(episode) }];
    this.markSaved(episode);
  }

  record(label: string, episode: Episode) {
    if (episode.manifest.lifecycle !== 'setup') {
      this.entries = [];
      this.index = 0;
      return;
    }
    if (
      this.entries[this.index] &&
      documentKey(this.entries[this.index].episode) === documentKey(episode)
    )
      return;
    this.entries.splice(this.index + 1);
    this.entries.push({ label, episode: checkpoint(episode) });
    this.index = this.entries.length - 1;
  }

  markSaved(episode: Episode) {
    this.savedDocument = episode.manifest.lifecycle;
    this.savedCalls = episode.revision;
    this.savedEntry = this.entries[this.index];
  }

  isDirty(episode: Episode) {
    return (
      this.savedCalls !== episode.revision ||
      this.savedDocument !== episode.manifest.lifecycle ||
      (episode.manifest.lifecycle === 'setup' && this.savedEntry !== this.entries[this.index])
    );
  }
}

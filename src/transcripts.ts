// Events can repeat or revise an utterance. Keep one current version per ID.
export class TranscriptBuffer {
  private utterances = new Map<string, {
    partial?: { revision: number; text: string };
    final?: { revision: number; text: string };
  }>();

  accept(event: { type?: string; utterance_id?: string; revision?: number; text?: string }): string {
    if (typeof event.text !== 'string') return this.text;
    const id = event.utterance_id ?? 'current';
    const revision = event.revision ?? 0;
    const entry = this.utterances.get(id) ?? {};
    const kind = event.type === 'transcript.final' ? 'final' : 'partial';
    const previous = entry[kind];
    if (!previous || revision >= previous.revision) {
      entry[kind] = { revision, text: event.text };
      this.utterances.set(id, entry);
    }
    return this.text;
  }

  get text(): string {
    return [...this.utterances.values()].map((entry) => (entry.final ?? entry.partial)?.text.trim()).filter(Boolean).join(' ');
  }
}

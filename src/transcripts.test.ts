import assert from 'node:assert/strict';
import test from 'node:test';
import { TranscriptBuffer } from './transcripts';

test('duplicate and revised segments replace an utterance rather than duplicating it', () => {
  const buffer = new TranscriptBuffer();
  const first = { utterance_id: 'first', revision: 1, text: 'Hello' };
  assert.equal(buffer.accept(first), 'Hello');
  assert.equal(buffer.accept(first), 'Hello');
  assert.equal(buffer.accept({ ...first, revision: 2, text: 'Hello world.' }), 'Hello world.');
  assert.equal(buffer.accept({ ...first, text: 'Stale text' }), 'Hello world.');
});

test('revisions preserve the order in which utterances first arrive', () => {
  const buffer = new TranscriptBuffer();
  buffer.accept({ utterance_id: 'first', revision: 1, text: '  First phrase.  ' });
  buffer.accept({ utterance_id: 'second', revision: 1, text: 'Second phrase.' });
  buffer.accept({ utterance_id: 'first', revision: 2, text: 'Corrected first phrase.' });
  assert.equal(buffer.text, 'Corrected first phrase. Second phrase.');
});

test('final text remains preferred even when a later segment arrives', () => {
  const buffer = new TranscriptBuffer();
  buffer.accept({ type: 'transcript.segment', utterance_id: 'first', revision: 1, text: 'Interim' });
  buffer.accept({ type: 'transcript.final', utterance_id: 'first', revision: 2, text: 'The final phrase.' });
  assert.equal(buffer.accept({ type: 'transcript.segment', utterance_id: 'first', revision: 3, text: 'Late interim' }), 'The final phrase.');
  assert.equal(buffer.accept({ type: 'transcript.final', utterance_id: 'first', revision: 1, text: 'Old final' }), 'The final phrase.');
  assert.equal(buffer.accept({ type: 'transcript.final', utterance_id: 'first', revision: 3, text: 'The corrected final phrase.' }), 'The corrected final phrase.');
});

test('empty or missing text does not add spaces or lose other utterances', () => {
  const buffer = new TranscriptBuffer();
  buffer.accept({ utterance_id: 'first', text: 'A phrase.' });
  buffer.accept({ utterance_id: 'empty', text: '  ' });
  assert.equal(buffer.accept({ utterance_id: 'first', revision: 10 }), 'A phrase.');
  assert.equal(buffer.accept({ utterance_id: 'last', text: 'A second phrase.' }), 'A phrase. A second phrase.');
});

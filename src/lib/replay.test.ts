import { expect, test } from 'vitest';
import {
  getReplayEventCount,
  hasReplayFullSnapshot,
  REPLAY_EVENT_FRAGMENT_TYPE,
  restoreReplayEventFragments,
} from './replay';

test('hasReplayFullSnapshot returns true when a full snapshot is present', () => {
  expect(hasReplayFullSnapshot([{ type: 4 }, { type: 2 }, { type: 3 }])).toBe(true);
});

test('hasReplayFullSnapshot returns false when only incremental events are present', () => {
  expect(hasReplayFullSnapshot([{ type: 4 }, { type: 3 }, { type: 3 }])).toBe(false);
});

test('hasReplayFullSnapshot handles missing events', () => {
  expect(hasReplayFullSnapshot(null)).toBe(false);
  expect(hasReplayFullSnapshot(undefined)).toBe(false);
});

test('restoreReplayEventFragments restores fragmented events', () => {
  const fullSnapshot = {
    type: 2,
    timestamp: 1781553116151,
    data: {
      node: {
        type: 0,
        childNodes: [{ type: 2, tagName: 'html' }],
      },
    },
  };
  const serialized = JSON.stringify(fullSnapshot);
  const splitAt = Math.floor(serialized.length / 2);

  const events = restoreReplayEventFragments([
    { type: 4, timestamp: 1781553116150 },
    {
      type: REPLAY_EVENT_FRAGMENT_TYPE,
      timestamp: fullSnapshot.timestamp,
      data: {
        id: 'snapshot-1',
        index: 0,
        total: 2,
        value: serialized.slice(0, splitAt),
      },
    },
    {
      type: REPLAY_EVENT_FRAGMENT_TYPE,
      timestamp: fullSnapshot.timestamp,
      data: {
        id: 'snapshot-1',
        index: 1,
        total: 2,
        value: serialized.slice(splitAt),
      },
    },
    { type: 3, timestamp: 1781553116160 },
  ]);

  expect(events).toEqual([
    { type: 4, timestamp: 1781553116150 },
    fullSnapshot,
    { type: 3, timestamp: 1781553116160 },
  ]);
  expect(hasReplayFullSnapshot(events)).toBe(true);
});

test('getReplayEventCount counts a fragment group as one event', () => {
  expect(
    getReplayEventCount([
      { type: 4 },
      {
        type: REPLAY_EVENT_FRAGMENT_TYPE,
        data: { id: 'snapshot-1', index: 0, total: 2, value: '{' },
      },
      {
        type: REPLAY_EVENT_FRAGMENT_TYPE,
        data: { id: 'snapshot-1', index: 1, total: 2, value: '}' },
      },
      { type: 3 },
    ]),
  ).toBe(3);
});

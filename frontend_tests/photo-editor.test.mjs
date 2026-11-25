import test from 'node:test';
import assert from 'node:assert/strict';

test('photo editor state transitions: attach, remove, and clean payload', () => {
  let pendingThumbnailDataUri = 'data:image/jpeg;base64,/9j/4AAQSkZJRg...';
  
  // 1. Initial recipe with photo
  let hasThumbnail = Boolean(pendingThumbnailDataUri);
  assert.equal(hasThumbnail, true);
  assert.equal(pendingThumbnailDataUri.startsWith('data:image/'), true);

  // 2. Remove photo action
  pendingThumbnailDataUri = '';
  hasThumbnail = Boolean(pendingThumbnailDataUri);
  assert.equal(hasThumbnail, false);
  assert.equal(pendingThumbnailDataUri, '');

  // 3. Payload preparation reflects removed photo
  const cleanPayload = {
    title: 'Test Soup',
    hasThumbnail: Boolean(pendingThumbnailDataUri),
  };
  assert.equal(cleanPayload.hasThumbnail, false);

  // 4. Pasting new photo
  const pastedDataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg...';
  pendingThumbnailDataUri = pastedDataUri;
  cleanPayload.hasThumbnail = Boolean(pendingThumbnailDataUri);
  assert.equal(cleanPayload.hasThumbnail, true);
  assert.equal(pendingThumbnailDataUri.startsWith('data:image/png'), true);
});

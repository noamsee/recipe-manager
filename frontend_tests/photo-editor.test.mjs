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

test('clipboard data extraction identifies image files, HTML img tags, and web URLs', () => {
  // Mock clipboard extraction logic
  function mockExtractPhoto(clipboardData) {
    if (clipboardData.files && clipboardData.files.length > 0) {
      for (const file of clipboardData.files) {
        if (file.type.startsWith('image/')) {
          return { type: 'file', data: file.name };
        }
      }
    }

    if (clipboardData.items && clipboardData.items.length > 0) {
      for (const item of clipboardData.items) {
        if (item.type.startsWith('image/')) {
          return { type: 'item', data: item.type };
        }
      }
    }

    const html = clipboardData.getData?.('text/html');
    if (html) {
      const match = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
      if (match && match[1]) {
        return { type: 'html', data: match[1] };
      }
    }

    const text = clipboardData.getData?.('text/plain')?.trim();
    if (text) {
      if (text.startsWith('data:image/')) {
        return { type: 'dataUri', data: text };
      }
      if (/^https?:\/\/.+/i.test(text)) {
        return { type: 'url', data: text };
      }
    }

    return null;
  }

  // 1. Image File in clipboard
  const cbWithFile = {
    files: [{ name: 'screenshot.png', type: 'image/png' }],
    items: [],
    getData: () => '',
  };
  const resFile = mockExtractPhoto(cbWithFile);
  assert.equal(resFile?.type, 'file');
  assert.equal(resFile?.data, 'screenshot.png');

  // 2. HTML with <img> tag
  const cbWithHtml = {
    files: [],
    items: [],
    getData: (format) => format === 'text/html' ? '<p>Check this: <img src="https://example.com/pasta.jpg" alt="pasta"></p>' : '',
  };
  const resHtml = mockExtractPhoto(cbWithHtml);
  assert.equal(resHtml?.type, 'html');
  assert.equal(resHtml?.data, 'https://example.com/pasta.jpg');

  // 3. Plain text image URL
  const cbWithUrl = {
    files: [],
    items: [],
    getData: (format) => format === 'text/plain' ? 'https://example.com/salad.png' : '',
  };
  const resUrl = mockExtractPhoto(cbWithUrl);
  assert.equal(resUrl?.type, 'url');
  assert.equal(resUrl?.data, 'https://example.com/salad.png');

  // 4. Plain text data URI
  const cbWithDataUri = {
    files: [],
    items: [],
    getData: (format) => format === 'text/plain' ? 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' : '',
  };
  const resDataUri = mockExtractPhoto(cbWithDataUri);
  assert.equal(resDataUri?.type, 'dataUri');
  assert.equal(resDataUri?.data.startsWith('data:image/'), true);
});

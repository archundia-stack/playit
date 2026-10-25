export function sampleRelease(over = {}) {
  return {
    id: 'rel_test', status: 'draft', title: 'Noches de Tequila', titleLang: 'es', contentType: 'Single', labelId: 7,
    artists: [{ name: 'Luna Arcos', role: 'primary' }, { name: 'DJ Nopal', role: 'featuring' }], cat: 'MSR-001', upc: '', genreId: 3, explicit: 'off',
    releaseDate: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), outlets: ['spotify', 'apple-music'],
    aiUsage: { artwork: 'none', audio: 'none', composition: 'none' },
    cover: { filename: 'portada.png', path: null, size: 10 },
    tracks: [{
      id: 'trk_1', num: 1, disc: 1, title: 'Noches de Tequila', titleLang: 'es', artists: [{ name: 'Luna Arcos', role: 'primary' }],
      compositionType: 'original_composition', audioLanguage: 'es', explicit: 'off', isrc: '', recordingCountry: 'MX', commercialSamples: 'no',
      aiUsage: { audio: 'none', composition: 'none' },
      writers: [{ firstName: 'Miguel', lastName: 'Archundia', roles: ['composer', 'lyricist'], share: 60 }, { firstName: '', lastName: 'Rivas', roles: ['composer'], share: 40 }],
      audio: { filename: 'pista.wav', path: null, size: 10, uploadedKey: null },
    }],
    provider: null, history: [], ...over,
  };
}

const Pg = require('./pg');

module.exports.getNbSongs = () =>
  Pg.q`SELECT COUNT(*) AS "nbSongs" FROM "Songs"`.then(
    ([{ nbSongs }]) => nbSongs
  );

module.exports.getLatestCharts = (offset = 0, limit = 20) =>
  Pg.q`
    SELECT *
    FROM "Songs"
    ORDER BY COALESCE("lastModified", "uploadedAt") DESC, "id" DESC
    LIMIT 20
    OFFSET ${+offset || 0}`.then(songs =>
    Promise.all([
      Pg.q`
        SELECT ss."songId", s."id", s."name", s."link", ss."parent", s."isSetlist", s."hideSingleDownloads"
        FROM "Songs_Sources" ss
        JOIN "Sources" s ON ss."sourceId" = s."id"
        WHERE "songId" IN (${songs.map(({ id }) => id)})
      `,
      Pg.q`
        SELECT * FROM "Songs_Hashes"
        WHERE "songId" IN (${songs.map(({ id }) => id)})
      `,
      Pg.q`
        SELECT "roles", "alias"
        FROM (
          SELECT "roles", UNNEST("aliases") AS "alias"
          FROM "Charters"
        ) c
        WHERE LOWER("alias") IN (${Object.keys(
          songs.reduce((charters, { charter }) => {
            const parts = (charter || '').split(/&|,|\+|\//).map(x => x.trim());
            parts.forEach(part => (charters[part.toLowerCase()] = 1));
            return charters;
          }, {})
        )})
      `
    ]).then(([sources, hashes, roles]) => {
      const songMap = Object.assign(
        {},
        ...songs.map(song => {
          delete song.words; // Users don't need them.
          return { [song.id]: song };
        })
      );
      sources.forEach(
        ({
          songId,
          id,
          name,
          link,
          parent,
          isSetlist,
          hideSingleDownloads
        }) => {
          if (hideSingleDownloads) songMap[songId].link = null;
          if (!songMap[songId].sources) songMap[songId].sources = [];
          if (parent) delete parent.parent; // We don't need the grand-parent. (yes this is ageist)
          songMap[songId].sources.push({ id, name, link, parent, isSetlist });
        }
      );
      hashes.forEach(({ songId, hash, part, difficulty }) => {
        if (!songMap[songId].hashes) songMap[songId].hashes = {};
        if (part == 'file') songMap[songId].hashes.file = hash;
        else {
          if (!songMap[songId].hashes[part]) songMap[songId].hashes[part] = {};
          songMap[songId].hashes[part][difficulty] = hash;
        }
      });
      return {
        // songs is still sorted by "lastModified" desc
        songs: songs.map(({ id }) => songMap[id]),
        roles: Object.assign(
          {},
          ...roles.map(({ roles, alias }) => ({ [alias.toLowerCase()]: roles }))
        )
      };
    })
  );

module.exports.upsertSource = ({
  name,
  link,
  isSetlist,
  hideSingleDownloads
}) =>
  Pg.q`
    INSERT INTO "Sources${{ sql: process.argv[2] ? '' : '_new' }}"
    ("name", "link", "isSetlist", "hideSingleDownloads")
    VALUES
    (${name}, ${link}, ${isSetlist}, ${hideSingleDownloads})
    ON CONFLICT ("link") DO UPDATE
    SET "name" = EXCLUDED."name"
    RETURNING *
  `.then(([source]) => source);

module.exports.upsertLinksToIgnore = toIgnore =>
  Promise.all([
    Pg.q`
    INSERT INTO "LinksToIgnore${{ sql: process.argv[2] ? '' : '_new' }}"
    ("link")
    VALUES
    ${toIgnore.map(({ link }) => [link])}
    ON CONFLICT DO NOTHING
  `,
    !process.argv[2] &&
      Pg.q`
    INSERT INTO "LinksToIgnore_new"
    ("link")
    SELECT "link" FROM "LinksToIgnore"
    ON CONFLICT DO NOTHING
  `
  ]);

// The diff_* fields are basically binary maps.
// For example, 0b0001 (1) is easy only, 0b1000 (8) is expert only,
// 0b1100 (12) is expert + hard.
// At the same time, remove noteCounts which are less than 10
// to possibly fix old charts with only one note at the start
// (people shouldn't publish 10-note charts anyway)
const getDiffsFromNoteCounts = noteCounts => {
  if (!noteCounts) return {};
  const diffs = {};
  for (part in noteCounts) {
    let flag = 0;
    for (diff in noteCounts[part]) {
      switch (diff) {
        case 'e':
          if (noteCounts[part][diff] > 10) flag += 1;
          else delete noteCounts[part][diff];
          break;
        case 'm':
          if (noteCounts[part][diff] > 10) flag += 2;
          else delete noteCounts[part][diff];
          break;
        case 'h':
          if (noteCounts[part][diff] > 10) flag += 4;
          else delete noteCounts[part][diff];
          break;
        case 'x':
          if (noteCounts[part][diff] > 10) flag += 8;
          else delete noteCounts[part][diff];
          break;
      }
    }
    if (flag) diffs[part] = flag;
  }
  return diffs;
};
module.exports.upsertSongs = async (songs, noUpdateLastModified) => {
  if (!songs.length) return;
  // Checking that a link doesn't appear twice
  songs = Object.values(
    songs.reduce((obj, song) => Object.assign(obj, { [song.link]: song }), {})
  );
  for (let i = 0; i < songs.length; i += 50) {
    if (!songs.slice(i, i + 50).length) continue;
    console.log('Inserting from', i, 'to', Math.min(i + 50, songs.length));
    const songIds = await Pg.q`
      INSERT INTO "Songs${{ sql: process.argv[2] ? '' : '_new' }}"
      (
        "name", "artist", "album", "genre", "year", "charter",
        "tier_band", "tier_guitar", "tier_bass", "tier_rhythm",
        "tier_drums", "tier_vocals", "tier_keys", "tier_guitarghl",
        "tier_bassghl", "diff_guitar", "diff_bass", "diff_rhythm",
        "diff_drums", "diff_keys", "diff_guitarghl", "diff_bassghl",
        "hasForced", "hasOpen", "hasTap", "hasSections", "hasStarPower",
        "hasSoloSections", "hasStems", "hasVideo", "hasLyrics",
        "hasNoAudio", "needsRenaming", "isFolder",
        "hasBrokenNotes", "hasBackground", "noteCounts", "link",
        "directLinks", "length", "effectiveLength", "is120",
        "lastModified", "uploadedAt", "isPack", "words"
      )
      VALUES
      ${songs
        .slice(i, i + 50)
        .map(
          ({
            defaultName,
            defaultArtist,
            name = '',
            artist = '',
            album = '',
            genre = '',
            year = '',
            charter = '',
            diff_band = -1,
            diff_guitar = -1,
            diff_bass = -1,
            diff_rhythm = -1,
            diff_drums = -1,
            diff_vocals = -1,
            diff_keys = -1,
            diff_guitarghl = -1,
            diff_bassghl = -1,
            hasForced,
            hasOpen,
            hasTap,
            hasSections,
            hasLyrics,
            song_length,
            hasStarPower,
            hasSoloSections,
            hasStems,
            hasVideo,
            hasNoAudio,
            needsRenaming,
            length,
            effectiveLength,
            isFolder,
            hasBrokenNotes,
            hasBackground,
            noteCounts,
            lastModified,
            link,
            chartMeta = {},
            source,
            parent = {},
            frets = '',
            isPack,
            directLinks,
            uploadedAt,
            is120
          }) => {
            const diffs = getDiffsFromNoteCounts(noteCounts);
            const wordableFields = [
              name || chartMeta.Name || defaultName || null,
              artist || chartMeta.Artist || defaultArtist || null,
              album || chartMeta.Album || null,
              genre || chartMeta.Genre || null,
              year || chartMeta.Year || null,
              charter || frets || chartMeta.Charter || null
            ];
            return [
              ...wordableFields,
              +diff_band >= 0 ? +diff_band >> 0 : null,
              +diff_guitar >= 0 ? +diff_guitar >> 0 : null,
              +diff_bass >= 0 ? +diff_bass >> 0 : null,
              +diff_rhythm >= 0 ? +diff_rhythm >> 0 : null,
              +diff_drums >= 0 ? +diff_drums >> 0 : null,
              +diff_vocals >= 0 ? +diff_vocals >> 0 : null,
              +diff_keys >= 0 ? +diff_keys >> 0 : null,
              +diff_guitarghl >= 0 ? +diff_guitarghl >> 0 : null,
              +diff_bassghl >= 0 ? +diff_bassghl >> 0 : null,
              diffs.guitar,
              diffs.bass,
              diffs.rhythm,
              diffs.drums,
              diffs.keys,
              diffs.guitarghl,
              diffs.bassghl,
              !!hasForced,
              hasOpen,
              !!hasTap,
              !!hasSections,
              !!hasStarPower,
              !!hasSoloSections,
              !!hasStems,
              !!hasVideo,
              !!hasLyrics,
              !!hasNoAudio,
              !!needsRenaming,
              !!isFolder,
              !!hasBrokenNotes,
              !!hasBackground,
              noteCounts ? JSON.stringify(noteCounts) : null,
              link,
              directLinks ? JSON.stringify(directLinks) : null,
              (song_length ? (song_length / 1000) >> 0 : chartMeta.length) ||
                length,
              chartMeta.effectiveLength || effectiveLength,
              is120,
              lastModified,
              uploadedAt || new Date().toISOString(),
              !!isPack,
              {
                sql: `array_to_string(tsvector_to_array(to_tsvector('simple', $$)), ' ')`,
                param: [
                  ...wordableFields,
                  source.name,
                  parent && parent.name,
                  (() => {
                    // Initials
                    const words = name
                      .split(' ')
                      .filter(word => word && (word[0] || '').match(/[A-z]/));
                    if (words.length < 3) return;
                    return words.map(word => word[0]).join('');
                  })()
                ]
                  .filter(x => x)
                  .join(' ')
                  .toLowerCase()
              }
            ];
          }
        )}
      ON CONFLICT ("link") DO UPDATE
      SET "name" = EXCLUDED."name",
        "artist" = EXCLUDED."artist",
        "album" = EXCLUDED."album",
        "genre" = EXCLUDED."genre",
        "year" = EXCLUDED."year",
        "charter" = EXCLUDED."charter",
        "length" = EXCLUDED."length",
        "effectiveLength" = EXCLUDED."effectiveLength",
        "directLinks" = EXCLUDED."directLinks",
        "tier_band" = EXCLUDED."tier_band",
        "tier_guitar" = EXCLUDED."tier_guitar",
        "tier_bass" = EXCLUDED."tier_bass",
        "tier_rhythm" = EXCLUDED."tier_rhythm",
        "tier_drums" = EXCLUDED."tier_drums",
        "tier_vocals" = EXCLUDED."tier_vocals",
        "tier_keys" = EXCLUDED."tier_keys",
        "tier_guitarghl" = EXCLUDED."tier_guitarghl",
        "tier_bassghl" = EXCLUDED."tier_bassghl",
        "diff_guitar" = EXCLUDED."diff_guitar",
        "diff_bass" = EXCLUDED."diff_bass",
        "diff_rhythm" = EXCLUDED."diff_rhythm",
        "diff_drums" = EXCLUDED."diff_drums",
        "diff_keys" = EXCLUDED."diff_keys",
        "diff_guitarghl" = EXCLUDED."diff_guitarghl",
        "diff_bassghl" = EXCLUDED."diff_bassghl",
        "hasForced" = EXCLUDED."hasForced",
        "hasOpen" = EXCLUDED."hasOpen",
        "hasTap" = EXCLUDED."hasTap",
        "hasSections" = EXCLUDED."hasSections",
        "hasStarPower" = EXCLUDED."hasStarPower",
        "hasSoloSections" = EXCLUDED."hasSoloSections",
        "hasStems" = EXCLUDED."hasStems",
        "noteCounts" = EXCLUDED."noteCounts",
        "words" = EXCLUDED."words"
      ${{
        sql: noUpdateLastModified
          ? ''
          : `,"lastModified" = EXCLUDED."lastModified"`
      }}
      RETURNING "id"
    `;
    await Promise.all([
      Pg.q`
        INSERT INTO "Songs_Sources${{ sql: process.argv[2] ? '' : '_new' }}"
        ("parent", "sourceId", "songId")
        VALUES
        ${songIds.map(({ id }, index) => [
          songs[i + index].parent
            ? JSON.stringify(songs[i + index].parent)
            : null,
          songs[i + index].source.chorusId,
          id
        ])}
        ON CONFLICT ("songId", "sourceId") DO UPDATE SET "parent" = EXCLUDED."parent"
      `,
      songs
        .slice(i, i + 50)
        .find(song => song.hashes && Object.keys(song.hashes).length) &&
        Pg.q`
        INSERT INTO "Songs_Hashes${{ sql: process.argv[2] ? '' : '_new' }}"
        ("hash", "part", "difficulty", "songId")
        VALUES
        ${songIds.reduce((arr, { id }, index) => {
          for (part in songs[i + index].hashes) {
            if (part == 'file')
              arr.push([songs[i + index].hashes.file, 'file', null, id]);
            else
              for (diff in songs[i + index].hashes[part]) {
                arr.push([
                  songs[i + index].hashes[part][diff],
                  part.trim(),
                  diff.trim(),
                  id
                ]);
              }
          }
          return arr;
        }, [])}
        ON CONFLICT DO NOTHING
      `
    ]);
  }
};

module.exports.search = async (query, offset, limit) => {
  // Oh my good!
  const [, name] = query.match(/name="([^"]+)"/) || [];
  const [, artist] = query.match(/artist="([^"]+)"/) || [];
  const [, album] = query.match(/album="([^"]+)"/) || [];
  const [, genre] = query.match(/genre="([^"]+)"/) || [];
  const [, charter] = query.match(/charter="([^"]+)"/) || [];
  const [, tier_band] = query.match(/tier_band=(.t\d)/) || [];
  const [, tier_guitar] = query.match(/tier_guitar=(.t\d)/) || [];
  const [, tier_bass] = query.match(/tier_bass=(.t\d)/) || [];
  const [, tier_rhythm] = query.match(/tier_rhythm=(.t\d)/) || [];
  const [, tier_drums] = query.match(/tier_drums=(.t\d)/) || [];
  const [, tier_vocals] = query.match(/tier_vocals=(.t\d)/) || [];
  const [, tier_keys] = query.match(/tier_keys=(.t\d)/) || [];
  const [, tier_guitarghl] = query.match(/tier_guitarghl=(.t\d)/) || [];
  const [, tier_bassghl] = query.match(/tier_bassghl=(.t\d)/) || [];
  const [, diff_guitar] = query.match(/diff_guitar=(\d\d?)/) || [];
  const [, diff_bass] = query.match(/diff_bass=(\d\d?)/) || [];
  const [, diff_rhythm] = query.match(/diff_rhythm=(\d\d?)/) || [];
  const [, diff_drums] = query.match(/diff_drums=(\d\d?)/) || [];
  const [, diff_keys] = query.match(/diff_keys=(\d\d?)/) || [];
  const [, diff_guitarghl] = query.match(/diff_guitarghl=(\d\d?)/) || [];
  const [, diff_bassghl] = query.match(/diff_bassghl=(\d\d?)/) || [];
  const [, hasForced] = query.match(/hasForced=(\d)/) || [];
  const [, hasOpen] = query.match(/hasOpen=(\d)/) || [];
  const [, hasTap] = query.match(/hasTap=(\d)/) || [];
  const [, hasSections] = query.match(/hasSections=(\d)/) || [];
  const [, hasStarPower] = query.match(/hasStarPower=(\d)/) || [];
  const [, hasSoloSections] = query.match(/hasSoloSections=(\d)/) || [];
  const [, hasStems] = query.match(/hasStems=(\d)/) || [];
  const [, hasVideo] = query.match(/hasVideo=(\d)/) || [];
  const [, hasLyrics] = query.match(/hasLyrics=(\d)/) || [];
  const [, is120] = query.match(/is120=(\d)/) || [];
  const [, md5] = query.match(/md5=([^ ]+)/) || [];

  const [, sort] = query.match(/sort=([^ ]+)/) || [];
  let sortSql = [];
  if (sort) {
    const fields = sort
      .split(',')
      .filter(field =>
        field.match(
          new RegExp(
            `^-?${[
              'name',
              'artist',
              'album',
              'genre',
              'charter',
              'tier_band',
              'tier_guitar',
              'tier_bass',
              'tier_rhythm',
              'tier_drums',
              'tier_vocals',
              'tier_keys',
              'tier_guitarghl',
              'tier_bassghl',
              'noteCount',
              'date'
            ].join('|')}$`
          )
        )
      );
    for (let field of fields) {
      const isDescending = field[0] == '-';
      if (isDescending) field = field.slice(1);

      if (field == 'noteCount') {
        field = `"noteCounts"->'guitar'->'x'`;
      } else if (field == 'date') {
        field = `COALESCE("lastModified", "uploadedAt")`;
      }

      sortSql.push(`${field} ${isDescending ? 'DESC' : 'ASC'}`);
    }
  }

  let songs;
  if (md5) {
    const md5s = md5.split(',');
    let queryIndex = 1;
    const queryParams = md5s;
    songs = await Pg.query(
      `
      select *
      from "Songs" s
      join (
        select "songId"
        from "Songs_Hashes"
        where
        ${md5s.map(() => `"hash" = $${queryIndex++}::text`).join(' or ')}
      ) sh on sh."songId" = s."id"
    `,
      queryParams
    );
  } else if (
    name ||
    artist ||
    album ||
    genre ||
    charter ||
    tier_band ||
    tier_guitar ||
    tier_bass ||
    tier_rhythm ||
    tier_drums ||
    tier_vocals ||
    tier_keys ||
    tier_guitarghl ||
    tier_bassghl ||
    diff_guitar ||
    diff_bass ||
    diff_rhythm ||
    diff_drums ||
    diff_keys ||
    diff_guitarghl ||
    diff_bassghl ||
    hasForced ||
    hasOpen ||
    hasTap ||
    hasSections ||
    hasStarPower ||
    hasSoloSections ||
    hasStems ||
    hasVideo ||
    hasLyrics ||
    is120
  ) {
    // Advanced search: detected.
    let queryIndex = 1;
    const queryParams = [];
    songs = await Pg.query(
      `
      select *
      from "Songs" s
      where 1 = 1
      ${
        name
          ? queryParams.push(name) &&
            `and name ilike concat('%', $${queryIndex++}::text, '%')`
          : ''
      }
      ${
        artist
          ? queryParams.push(artist) &&
            `and artist ilike concat('%', $${queryIndex++}::text, '%')`
          : ''
      }
      ${
        album
          ? queryParams.push(album) &&
            `and album ilike concat('%', $${queryIndex++}::text, '%')`
          : ''
      }
      ${
        genre
          ? queryParams.push(genre) &&
            `and genre ilike concat('%', $${queryIndex++}::text, '%')`
          : ''
      }
      ${
        charter
          ? queryParams.push(charter) &&
            `and charter ilike concat('%', $${queryIndex++}::text, '%')`
          : ''
      }
      ${
        tier_band
          ? queryParams.push(tier_band[2]) &&
            `
        and tier_band is not null
        and tier_band ${tier_band[0] == 'g' ? '>' : '<'}= $${queryIndex++}`
          : ''
      }
      ${
        tier_guitar
          ? queryParams.push(tier_guitar[2]) &&
            `
        and tier_guitar is not null
        and tier_guitar ${tier_guitar[0] == 'g' ? '>' : '<'}= $${queryIndex++}`
          : ''
      }
      ${
        tier_bass
          ? queryParams.push(tier_bass[2]) &&
            `
        and tier_bass is not null
        and tier_bass ${tier_bass[0] == 'g' ? '>' : '<'}= $${queryIndex++}`
          : ''
      }
      ${
        tier_rhythm
          ? queryParams.push(tier_rhythm[2]) &&
            `
        and tier_rhythm is not null
        and tier_rhythm ${tier_rhythm[0] == 'g' ? '>' : '<'}= $${queryIndex++}`
          : ''
      }
      ${
        tier_drums
          ? queryParams.push(tier_drums[2]) &&
            `
        and tier_drums is not null
        and tier_drums ${tier_drums[0] == 'g' ? '>' : '<'}= $${queryIndex++}`
          : ''
      }
      ${
        tier_vocals
          ? queryParams.push(tier_vocals[2]) &&
            `
        and tier_vocals is not null
        and tier_vocals ${tier_vocals[0] == 'g' ? '>' : '<'}= $${queryIndex++}`
          : ''
      }
      ${
        tier_keys
          ? queryParams.push(tier_keys[2]) &&
            `
        and tier_keys is not null
        and tier_keys ${tier_keys[0] == 'g' ? '>' : '<'}= $${queryIndex++}`
          : ''
      }
      ${
        tier_guitarghl
          ? queryParams.push(tier_guitarghl[2]) &&
            `
        and tier_guitarghl is not null
        and tier_guitarghl ${
          tier_guitarghl[0] == 'g' ? '>' : '<'
        }= $${queryIndex++}`
          : ''
      }
      ${
        tier_bassghl
          ? queryParams.push(tier_bassghl[2]) &&
            `
        and tier_bassghl is not null
        and tier_bassghl ${
          tier_bassghl[0] == 'g' ? '>' : '<'
        }= $${queryIndex++}`
          : ''
      }
      ${
        diff_guitar
          ? queryParams.push(diff_guitar) &&
            `
        and diff_guitar is not null
        and diff_guitar & $${queryIndex} = $${queryIndex++}`
          : ''
      }
      ${
        diff_bass
          ? queryParams.push(diff_bass) &&
            `
        and diff_bass is not null
        and diff_bass & $${queryIndex} = $${queryIndex++}`
          : ''
      }
      ${
        diff_rhythm
          ? queryParams.push(diff_rhythm) &&
            `
        and diff_rhythm is not null
        and diff_rhythm & $${queryIndex} = $${queryIndex++}`
          : ''
      }
      ${
        diff_drums
          ? queryParams.push(diff_drums) &&
            `
        and diff_drums is not null
        and diff_drums & $${queryIndex} = $${queryIndex++}`
          : ''
      }
      ${
        diff_keys
          ? queryParams.push(diff_keys) &&
            `
        and diff_keys is not null
        and diff_keys & $${queryIndex} = $${queryIndex++}`
          : ''
      }
      ${
        diff_guitarghl
          ? queryParams.push(diff_guitarghl) &&
            `
        and diff_guitarghl is not null
        and diff_guitarghl & $${queryIndex} = $${queryIndex++}`
          : ''
      }
      ${
        diff_bassghl
          ? queryParams.push(diff_bassghl) &&
            `
        and diff_bassghl is not null
        and diff_bassghl & $${queryIndex} = $${queryIndex++}`
          : ''
      }
      ${
        hasForced
          ? queryParams.push(!!+hasForced) &&
            `
        and (
          "hasForced" is ${hasForced == 1 ? 'not' : ''} null
          ${hasForced == 1 ? 'and' : 'or'} "hasForced" = $${queryIndex++}
        )`
          : ''
      }
      ${
        hasOpen
          ? `
        and (
          "hasOpen" is ${hasOpen == 1 ? 'not' : ''} null
          ${hasOpen == 1 ? 'and' : 'or'} "hasOpen" ${
              hasOpen == 1 ? '!' : ''
            }= '{}'
        )`
          : ''
      }
      ${
        hasTap
          ? queryParams.push(!!+hasTap) &&
            `
        and (
          "hasTap" is ${hasTap == 1 ? 'not' : ''} null
          ${hasTap == 1 ? 'and' : 'or'} "hasTap" = $${queryIndex++}
        )`
          : ''
      }
      ${
        hasSections
          ? queryParams.push(!!+hasSections) &&
            `
        and (
          "hasSections" is ${hasSections == 1 ? 'not' : ''} null
          ${hasSections == 1 ? 'and' : 'or'} "hasSections" = $${queryIndex++}
        )`
          : ''
      }
      ${
        hasStarPower
          ? queryParams.push(!!+hasStarPower) &&
            `
        and (
          "hasStarPower" is ${hasStarPower == 1 ? 'not' : ''} null
          ${hasStarPower == 1 ? 'and' : 'or'} "hasStarPower" = $${queryIndex++}
        )`
          : ''
      }
      ${
        hasSoloSections
          ? queryParams.push(!!+hasSoloSections) &&
            `
        and (
          "hasSoloSections" is ${hasSoloSections == 1 ? 'not' : ''} null
          ${
            hasSoloSections == 1 ? 'and' : 'or'
          } "hasSoloSections" = $${queryIndex++}
        )`
          : ''
      }
      ${
        hasStems
          ? queryParams.push(!!+hasStems) &&
            `
        and (
          "hasStems" is ${hasStems == 1 ? 'not' : ''} null
          ${hasStems == 1 ? 'and' : 'or'} "hasStems" = $${queryIndex++}
        )`
          : ''
      }
      ${
        hasVideo
          ? queryParams.push(!!+hasVideo) &&
            `
        and (
          "hasVideo" is ${hasVideo == 1 ? 'not' : ''} null
          ${hasVideo == 1 ? 'and' : 'or'} "hasVideo" = $${queryIndex++}
        )`
          : ''
      }
      ${
        hasLyrics
          ? queryParams.push(!!+hasLyrics) &&
            `
        and (
          "hasLyrics" is ${hasLyrics == 1 ? 'not' : ''} null
          ${hasLyrics == 1 ? 'and' : 'or'} "hasLyrics" = $${queryIndex++}
        )`
          : ''
      }
      ${
        is120
          ? queryParams.push(!!+is120) &&
            `
        and (
          "is120" is ${is120 == 1 ? 'not' : ''} null
          ${is120 == 1 ? 'and' : 'or'} "is120" = $${queryIndex++}
        )`
          : ''
      }
      ${
        sortSql.length
          ? `
        ORDER BY
        ${sortSql.join(',')}
      `
          : ''
      }
      limit ${+limit > 0 ? Math.max(+limit, 100) : 20}
      ${+offset ? `OFFSET ${+offset}` : ''}
    `,
      queryParams
    );
  } else {
    // Fall back to quick search
    songs = await Pg.query(
      `
      select s.* from "Songs" s
      where
        regexp_split_to_array(lower($1), '[\\s\\-/]+') <@
        regexp_split_to_array(
          words,
          '[\\s\\-/]+'
        )
      limit ${+limit > 0 ? Math.max(+limit, 100) : 20}
      ${+offset ? `OFFSET ${+offset}` : ''}
    `,
      [query]
    );
  }
  if (!songs.length) return { songs: [], roles: {} };
  // Populate the results with sources and hashes
  return Promise.all([
    Pg.q`
      SELECT ss."songId", s."id", s."name", s."link", ss."parent", s."isSetlist", s."hideSingleDownloads"
      FROM "Songs_Sources" ss
      JOIN "Sources" s ON ss."sourceId" = s."id"
      WHERE "songId" IN (${songs.map(({ id }) => id)})
    `,
    Pg.q`
      SELECT * FROM "Songs_Hashes"
      WHERE "songId" IN (${songs.map(({ id }) => id)})
    `,
    Pg.q`
      SELECT "roles", "alias"
      FROM (
        SELECT "roles", UNNEST("aliases") AS "alias"
        FROM "Charters"
      ) c
      WHERE LOWER("alias") IN (${Object.keys(
        songs.reduce((charters, { charter }) => {
          if (!charter) return charters;
          const parts = charter.split(/&|,|\+|\//).map(x => x.trim());
          parts.forEach(part => (charters[part.toLowerCase()] = 1));
          return charters;
        }, {})
      )})
    `
  ]).then(([sources, hashes, roles]) => {
    const songMap = Object.assign(
      {},
      ...songs.map(song => {
        delete song.words; // Users don't need them.
        return { [song.id]: song };
      })
    );
    sources.forEach(
      ({ songId, id, name, link, parent, isSetlist, hideSingleDownloads }) => {
        if (hideSingleDownloads) songMap[songId].link = null;
        if (!songMap[songId].sources) songMap[songId].sources = [];
        if (parent) delete parent.parent; // We don't need the grand-parent. (yes this is ageist)
        songMap[songId].sources.push({ id, name, link, parent, isSetlist });
      }
    );
    // If MD5 is defined, sort by order provided
    const md5s = md5 ? md5.split(',') : null;
    const sortedSongs = [];
    hashes.forEach(({ songId, hash, part, difficulty }) => {
      if (!songMap[songId].hashes) songMap[songId].hashes = {};
      if (part == 'file') {
        songMap[songId].hashes.file = hash;
        if (md5) sortedSongs[md5s.indexOf(hash)] = songMap[songId];
      } else {
        if (!songMap[songId].hashes[part]) songMap[songId].hashes[part] = {};
        songMap[songId].hashes[part][difficulty] = hash;
      }
    });
    if (md5) songs = sortedSongs.filter(x => x);
    return {
      // songs is still sorted by the proper filter
      songs: songs.map(({ id }) => songMap[id]),
      roles: Object.assign(
        {},
        ...roles.map(({ roles, alias }) => ({ [alias.toLowerCase()]: roles }))
      )
    };
  });
};

module.exports.getLinksMapBySource = ({ link }) =>
  process.env.REFRESH
    ? Promise.resolve({})
    : Promise.all([
        Pg.q`
    select s.link, row_to_json(s) as "meta", sh."hashes"
    from "Songs_Sources" ss
    join "Songs" s on ss."songId" = s."id"
    join (
      select "songId", array_agg(row_to_json(sh)) as "hashes"
      from "Songs_Hashes" sh
      group by "songId"
    ) sh on sh."songId" = s."id"
    where ss."sourceId" = (
      select "id" from "Sources"
      where "link" = ${link}
    )
  `,
        Pg.q`
    select "link"
    from "LinksToIgnore"
  `
      ])
        .then(([songs, toIgnore]) =>
          Object.assign(
            {},
            ...songs.concat(toIgnore).map(song => ({
              [song.link]: song.meta
                ? {
                    ...song.meta,
                    diff_band:
                      '' +
                      (song.meta.tier_band == null ? -1 : song.meta.tier_band),
                    diff_guitar:
                      '' +
                      (song.meta.tier_guitar == null
                        ? -1
                        : song.meta.tier_guitar),
                    diff_bass:
                      '' +
                      (song.meta.tier_bass == null ? -1 : song.meta.tier_bass),
                    diff_rhythm:
                      '' +
                      (song.meta.tier_rhythm == null
                        ? -1
                        : song.meta.tier_rhythm),
                    diff_drums:
                      '' +
                      (song.meta.tier_drums == null
                        ? -1
                        : song.meta.tier_drums),
                    diff_vocals:
                      '' +
                      (song.meta.tier_vocals == null
                        ? -1
                        : song.meta.tier_vocals),
                    diff_keys:
                      '' +
                      (song.meta.tier_keys == null ? -1 : song.meta.tier_keys),
                    diff_guitarghl:
                      '' +
                      (song.meta.tier_guitarghl == null
                        ? -1
                        : song.meta.tier_guitarghl),
                    diff_bassghl:
                      '' +
                      (song.meta.tier_bassghl == null
                        ? -1
                        : song.meta.tier_bassghl),
                    hashes: (() => {
                      const parts = {};
                      song.hashes.forEach(({ hash, part, difficulty }) => {
                        if (!parts[part]) parts[part] = {};
                        if (part == 'file') parts.file = hash;
                        else parts[part][difficulty] = hash;
                      });
                      return parts;
                    })()
                  }
                : { ignore: true }
            }))
          )
        )
        .catch(err => console.error(err.stack) || {});

module.exports.getSongsSample = () =>
  Pg.q`select * from "Songs" tablesample bernoulli (0.15) limit 20`.then(
    songs =>
      Promise.all([
        Pg.q`
      SELECT ss."songId", s."id", s."name", s."link", ss."parent", s."isSetlist", s."hideSingleDownloads"
      FROM "Songs_Sources" ss
      JOIN "Sources" s ON ss."sourceId" = s."id"
      WHERE "songId" IN (${songs.map(({ id }) => id)})
    `,
        Pg.q`
      SELECT * FROM "Songs_Hashes"
      WHERE "songId" IN (${songs.map(({ id }) => id)})
    `,
        Pg.q`
      SELECT "roles", "alias"
      FROM (
        SELECT "roles", UNNEST("aliases") AS "alias"
        FROM "Charters"
      ) c
      WHERE LOWER("alias") IN (${Object.keys(
        songs.reduce((charters, { charter }) => {
          const parts = (charter || '').split(/&|,|\+|\//).map(x => x.trim());
          parts.forEach(part => (charters[part.toLowerCase()] = 1));
          return charters;
        }, {})
      )})
    `
      ]).then(([sources, hashes, roles]) => {
        const songMap = Object.assign(
          {},
          ...songs.map(song => {
            delete song.words; // Users don't need them.
            return { [song.id]: song };
          })
        );
        sources.forEach(
          ({
            songId,
            id,
            name,
            link,
            parent,
            isSetlist,
            hideSingleDownloads
          }) => {
            if (hideSingleDownloads) songMap[songId].link = null;
            if (!songMap[songId].sources) songMap[songId].sources = [];
            if (parent) delete parent.parent; // We don't need the grand-parent. (yes this is ageist)
            songMap[songId].sources.push({ id, name, link, parent, isSetlist });
          }
        );
        hashes.forEach(({ songId, hash, part, difficulty }) => {
          if (!songMap[songId].hashes) songMap[songId].hashes = {};
          if (part == 'file') songMap[songId].hashes.file = hash;
          else {
            if (!songMap[songId].hashes[part])
              songMap[songId].hashes[part] = {};
            songMap[songId].hashes[part][difficulty] = hash;
          }
        });
        return {
          songs: songs.map(({ id }) => songMap[id]),
          roles: Object.assign(
            {},
            ...roles.map(({ roles, alias }) => ({
              [alias.toLowerCase()]: roles
            }))
          )
        };
      })
  );

module.exports.trackClick = ({ id }) => Pg.q`
  INSERT INTO "Clicks"
  ("link", "count")
  VALUES
  ((SELECT "link" FROM "Songs" WHERE "id" = ${id}), 1)
  ON CONFLICT ("link")
  do update set "count" = "Clicks"."count" + 1
`;

module.exports.checkIfSourceExistsInNew = () => false;

module.exports.checkIfLinkInNew = ({ link }) =>
  Pg.q`
SELECT 1
FROM "Songs_new"
WHERE "link" = ${link}
`.then(([exists]) => exists);

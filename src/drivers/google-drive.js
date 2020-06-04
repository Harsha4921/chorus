const Drive = require('../utils/drive');
const Request = require('request');
const Fs = require('fs');
const Path = require('path');

const getMetaFromArchive = require('../utils/extract/archive');
const getMetaFromFolder = require('../utils/extract/gdrive-folder');

const {
  upsertSource,
  upsertSongs,
  upsertLinksToIgnore,
  getLinksMapBySource,
  checkIfLinkInNew
} = require('../utils/db');

const prefixLength = 'https://drive.google.com/uc?id='.length;

// Max timeout = 5 minutes
// Retry 5 times maximum
const download = (url, attempt) =>
  new Promise(async (resolve, reject) => {
    const [, fileId] =
      url.match(/id=([^&]+)&?/) || url.match(/folders\/([^?]+)/) || [];

    if (!fileId) {
      Request.get(url, { encoding: null }, (err, res) => {
        if (err) return reject(err);
        // Bypass the download warning page if there's one
        if (res.body.toString('utf8', 0, 15) == '<!DOCTYPE html>') {
          return Drive.get(
            url.slice(prefixLength, url.indexOf('&', prefixLength))
          )
            .then(body => resolve(body))
            .catch(err => console.error(err) || resolve(res.body));
        }
        resolve(res.body);
      });
    } else {
      resolve(await Drive.get(fileId));
    }
  });

const defaultNameParser = txt => {
  let [artist, ...songParts] = txt.split(' - ');
  if (!songParts || !songParts.length)
    return { artist: 'N/A', name: txt.replace(/\.(zip|rar|7z)$/, '') };
  const name = songParts.join(' - ').replace(/\.(zip|rar|7z)$/, '');
  return { artist: artist.trim(), name: name.trim() };
};

module.exports = async ({
  name,
  link,
  proxy,
  isSetlist,
  hideSingleDownloads
}) => {
  console.log('Adding', name);
  // Supporting both https://drive.google.com/open?id=<drive_id>
  // and https://drive.google.com/drive/folders/<drive_id> syntaxes
  // `proxy` is a link that will be displayed instead of the link as a source (useful for rehosts)
  const questionMarkIndex = link.indexOf('?');
  const source = {
    name,
    link: proxy || link,
    isSetlist,
    hideSingleDownloads,
    id:
      link.indexOf('/open?id=') > -1
        ? link.slice(link.indexOf('/open?id=') + 9)
        : link.slice(
            link.lastIndexOf('/') + 1,
            questionMarkIndex < 0 ? undefined : questionMarkIndex
          )
  };

  // 1. Registering the source, or finding its ID if it already exists
  console.log('Registering/finding source');
  source.chorusId = (await upsertSource(source)).id;
  if (source.proxy) source.link = link;

  // 2. Get the map of already indexed links so that they don't get parsed again
  const linksMap = await getLinksMapBySource(source);

  /*
    3. Attempt to discover songs inside the drive
    A song can be either a folder with "song.ini", "notes.chart" and audio files in it,
    or archives (.zip/.rar/.7z).
  */
  console.log('Looking for chart folders and archives');
  const toIgnore = Object.keys(linksMap)
    .filter(link => linksMap[link].ignore)
    .map(link => ({ sourceId: source.chorusId, link }));
  const searchSongFolders = async folder => {
    console.log('Looking inside', folder.name);
    // If recover mode and link has already been inserted, skip
    if (process.env.RECOVER) {
      if (await checkIfLinkInNew({ link: folder.webViewLink })) return;
    }
    // If this belongs to the blacklist, skip
    if (linksMap[folder.webViewLink] && linksMap[folder.webViewLink].ignore)
      return;
    // List files inside the folder
    const archives = [];
    const subfolders = [];
    const files = { chart: [], mid: [], audio: [], background: [] };
    const content = await Drive.list({ q: `'${folder.id}' in parents` });

    for (let item of content) {
      // If recover mode and link has already been inserted, skip
      if (process.env.RECOVER) {
        if (await checkIfLinkInNew({ link: item.webContentLink })) continue;
      }

      // Resolve shortcuts as proper folders before going on
      if (item.mimeType == 'application/vnd.google-apps.shortcut') {
        item = await Drive.info(item.shortcutDetails.targetId);
      }

      // Store subfolders for recursion
      if (item.mimeType == 'application/vnd.google-apps.folder') {
        subfolders.push(item);
        continue;
      }
      // Store archives for processing
      // Archives might or might not be songs.
      // The 200 MB threshold is just mostly here to not kill my bandwidth with multi-GB packs, which are therefore excluded.
      // The good practice for such packs would be to rehost it (either by individual charters, or independently with separate
      // folders/archives for each song)
      // 2019-03-31: Increasing it to 500 MB to attempt taking modcharts/video backgrounds into account
      if (
        ['rar', 'zip', '7z'].indexOf(item.fileExtension) >= 0 &&
        item.size < 52428800 &&
        item.webContentLink
      ) {
        archives.push(item);
        continue;
      }

      // Otherwise, try to find relevant chart files
      // (there might be several .mid/.chart files, which is why they're arrays)
      if (item.name == 'song.ini') files.ini = item;
      else if (item.name.slice(0, 6) == 'video.') files.video = item;
      else if (item.name.match(/\.(ogg|mp3|wav)$/i)) files.audio.push(item);
      else if (item.fileExtension) {
        if (item.fileExtension.match(/png|jpe?g/)) {
          if (!item.name.match(/^album\./)) files.album = item;
          else if (!item.name.match(/^background(\d+)?\./))
            files.background.push(item);
        } else if (item.fileExtension == 'chart') files.chart.push(item);
        else if (item.fileExtension == 'mid') files.mid.push(item);
      }
    }

    // Find the most recent modification date
    let uploadedAt = (folder.modifiedTime || '').slice(0, 19);
    if (files.album && uploadedAt < files.album.modifiedTime)
      uploadedAt = files.album.modifiedTime.slice(0, 19);
    if (files.ini && uploadedAt < files.ini.modifiedTime)
      uploadedAt = files.ini.modifiedTime.slice(0, 19);
    if (files.video && uploadedAt < files.video.modifiedTime)
      uploadedAt = files.video.modifiedTime.slice(0, 19);
    if (files.chart.length)
      files.chart.forEach(({ modifiedTime }) => {
        if (uploadedAt < modifiedTime) uploadedAt = modifiedTime.slice(0, 19);
      });
    if (files.mid.length)
      files.mid.forEach(({ modifiedTime }) => {
        if (uploadedAt < modifiedTime) uploadedAt = modifiedTime.slice(0, 19);
      });
    if (files.audio.length)
      files.audio.forEach(({ modifiedTime }) => {
        if (uploadedAt < modifiedTime) uploadedAt = modifiedTime.slice(0, 19);
      });

    // If the folder link was already indexed and the modification date is the same, do not reprocess it
    // (i.e. re-insert it with the same metadata as before)
    if (
      linksMap[folder.webViewLink] &&
      (linksMap[folder.webViewLink].uploadedAt || '').slice(0, 19) == uploadedAt
    ) {
      await upsertSongs([
        Object.assign(linksMap[folder.webViewLink], {
          source,
          parent:
            folder.canBeParent && folder.parentFolder
              ? {
                  name: folder.parentFolder.name,
                  link: folder.parentFolder.webViewLink
                }
              : null
        })
      ]);
    } else {
      // Check if this is a song folder
      const meta = await getMetaFromFolder(files);
      if (meta) {
        // Computing default artist and song names in case there's no song.ini file,
        // and also inputing already available metadata
        const { artist: defaultArtist, name: defaultName } = defaultNameParser(
          folder.name
        );
        // The parent of a folder is its own parent folder
        const song = {
          defaultArtist,
          defaultName,
          lastModified: null, // unfortunately, it looks like it's impossible to get the real last file modification time from single files...
          uploadedAt,
          source,
          link: folder.webViewLink,
          parent:
            folder.canBeParent && folder.parentFolder
              ? {
                  name: folder.parentFolder.name,
                  link: folder.parentFolder.webViewLink
                }
              : null
        };
        console.log(
          `> Found "${meta.name ||
            (meta.chartMeta || {}).Name ||
            defaultName}" by "${meta.artist ||
            (meta.chartMeta || {}).Artist ||
            defaultArtist ||
            '???'}"`
        );
        await upsertSongs([Object.assign(song, meta, { isFolder: true })]);
      }
    }

    // Process archives
    for (let i = 0; i < archives.length; i++) {
      const file = archives[i];
      // Single songs
      if (linksMap[file.webViewLink]) {
        if (linksMap[file.webViewLink].ignore) continue;
        if (
          (linksMap[file.webViewLink].uploadedAt || '').slice(0, 19) ==
          file.modifiedTime.slice(0, 19)
        ) {
          await upsertSongs([
            Object.assign(linksMap[file.webViewLink], {
              source,
              parent: folder.canBeParent
                ? {
                    name: folder.name,
                    link: folder.webViewLink
                  }
                : null
            })
          ]);
          continue;
        }
      }
      // Packs
      if (
        linksMap[`${file.webViewLink}&i=1`] &&
        (linksMap[`${file.webViewLink}&i=1`].uploadedAt || '').slice(0, 19) ==
          file.modifiedTime.slice(0, 19)
      ) {
        for (let i = 1; linksMap[`${file.webViewLink}&i=${i}`]; i++) {
          await upsertSongs([
            Object.assign(linksMap[`${file.webViewLink}&i=${i}`], {
              source,
              parent: folder.canBeParent
                ? {
                    name: folder.name,
                    link: folder.webViewLink
                  }
                : null
            })
          ]);
        }
        continue;
      }
      console.log('Extracting', file.name);
      const archive = await download(file.webContentLink);
      const metaList = await getMetaFromArchive(archive, file.fileExtension);
      if (!metaList || !metaList.length)
        toIgnore.push({ sourceId: source.chorusId, link: file.webViewLink });
      else {
        // Computing default artist and song names in case there's no song.ini file,
        // and also inputing already available metadata
        const { artist: defaultArtist, name: defaultName } = defaultNameParser(
          file.name
        );
        const song = {
          defaultArtist,
          defaultName,
          lastModified: file.modifiedTime,
          uploadedAt: file.modifiedTime,
          source,
          link: file.webViewLink,
          directLinks: { archive: file.webContentLink },
          isPack: metaList.length > 1,
          parent: folder.canBeParent
            ? {
                name: folder.name,
                link: folder.webViewLink
              }
            : null
        };
        for (let index = 0; index < metaList.length; ++index) {
          const meta = metaList[index];
          console.log(
            `> Found "${meta.name ||
              (meta.chartMeta || {}).Name ||
              defaultName}" by "${meta.artist ||
              (meta.chartMeta || {}).Artist ||
              defaultArtist ||
              '???'}"`
          );
          // An awful trick to have unique links for multiple items in a pack
          await upsertSongs([
            Object.assign({}, song, meta, {
              link: song.isPack ? `${song.link}&i=${index + 1}` : song.link
            })
          ]);
        }
      }
    }

    // Recurse on subfolders
    for (let i = 0; i < subfolders.length; i++) {
      if (folder.canBeParent) {
        subfolders[i].parentFolder = folder;
        subfolders[i].name = `${folder.name}/${subfolders[i].name}`;
      }
      subfolders[i].canBeParent = true;
      await searchSongFolders(subfolders[i]);
    }
  };
  await searchSongFolders(source);

  // 4. Update the list of links to ignore (e.g. invalid archives, stray files...)
  if (toIgnore.length) await upsertLinksToIgnore(toIgnore);
};

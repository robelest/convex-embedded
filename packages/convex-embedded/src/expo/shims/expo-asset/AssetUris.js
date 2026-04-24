function getBasename(pathname) {
  return pathname.substring(pathname.lastIndexOf("/") + 1);
}

export function getFilename(url) {
  const { pathname, searchParams } = new URL(url, "https://e");

  if (__DEV__ && searchParams.has("unstable_path")) {
    const encodedFilePath = decodeURIComponent(
      searchParams.get("unstable_path"),
    );
    return getBasename(encodedFilePath);
  }

  return getBasename(pathname);
}

export function getFileExtension(url) {
  const filename = getFilename(url);
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex > 0 ? filename.substring(dotIndex) : "";
}

export function getManifestBaseUrl(manifestUrl) {
  const parsed = new URL(manifestUrl);
  const nextProtocol =
    parsed.protocol === "exp:"
      ? "http:"
      : parsed.protocol === "exps:"
        ? "https:"
        : parsed.protocol;
  const directory = parsed.pathname.substring(
    0,
    parsed.pathname.lastIndexOf("/") + 1,
  );

  return `${nextProtocol}//${parsed.host}${directory}`;
}

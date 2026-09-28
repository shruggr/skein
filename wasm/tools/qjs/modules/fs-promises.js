import { fsPromises } from "skein:node";
export default fsPromises;
export const { readFile, writeFile, appendFile, stat, lstat, readdir, mkdir, unlink, rmdir, rm, rename, copyFile, realpath,
  readlink, symlink, access } = fsPromises;

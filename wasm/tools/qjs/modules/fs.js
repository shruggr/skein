import { fs } from "skein:node";
export default fs;
export const { constants, promises, readFileSync, writeFileSync, appendFileSync, existsSync, accessSync, statSync, lstatSync,
  readdirSync, mkdirSync, unlinkSync, rmdirSync, rmSync, renameSync, copyFileSync, realpathSync, readlinkSync, symlinkSync } = fs;

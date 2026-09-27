import { Capacitor, registerPlugin } from '@capacitor/core';

export const nativePlugins = {
  App: registerPlugin('App'),
  Filesystem: registerPlugin('Filesystem'),
  Share: registerPlugin('Share'),
  StatusBar: registerPlugin('StatusBar'),
  NavigationBar: registerPlugin('NavigationBar'),
  NocturneLan: registerPlugin('NocturneLan'),
};
export { Capacitor };

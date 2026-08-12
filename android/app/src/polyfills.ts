/** Runtime APIs missing from the oldest Android WebView supported by the APK. */
export function installAndroidPolyfills(): void {
  if (typeof Object.hasOwn !== 'function') {
    Object.defineProperty(Object, 'hasOwn', {
      configurable: true,
      writable: true,
      value: (object: object, key: PropertyKey) =>
        Object.prototype.hasOwnProperty.call(object, key),
    });
  }
}

installAndroidPolyfills();

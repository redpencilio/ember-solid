solid-addon
==============================================================================

[Short description of the addon.]


Compatibility
------------------------------------------------------------------------------

* Ember.js v3.24 or above
* Ember CLI v3.24 or above
* Node.js v12 or above


Installation
------------------------------------------------------------------------------

```
npm remove ember-data
ember install ember-solid-store
```


Usage
------------------------------------------------------------------------------

[Longer description of how to use the addon in apps.]


Local development in a consuming app
------------------------------------------------------------------------------

Vite-based consumers (e.g. `frontend-solid-forge`) cannot resolve ember-solid's
dependencies (like `rdflib`) when the package is referenced as a bare directory
(`file:../../ember-solid`). Use a packed tarball instead:

1. From the `ember-solid` root, pack into the consumer's vendor folder:
   ```bash
   npm pack --pack-destination ../frontend-solid-forge/vendor/
   ```
2. In the consumer's `package.json`, reference the tgz:
   ```json
   "ember-solid": "file:vendor/ember-solid-0.3.5.tgz"
   ```
   Update the filename to match the packed version.
3. Run `npm install` in the consumer, then restart its dev server.

Repeat steps 1–3 after each change to ember-solid.


Contributing
------------------------------------------------------------------------------

See the [Contributing](CONTRIBUTING.md) guide for details.


License
------------------------------------------------------------------------------

This project is licensed under the [MIT License](LICENSE.md).

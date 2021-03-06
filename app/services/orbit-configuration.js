import Orbit, {
  ClientError,
  NetworkError
} from '@orbit/data';
import {
  EventLoggingStrategy,
  LogTruncationStrategy,
  RequestStrategy,
  SyncStrategy
} from '@orbit/coordinator';
import { oqb } from '@orbit/data';
import JSONAPISource from '@orbit/jsonapi';
import LocalStorageSource from '@orbit/local-storage';
import LocalStorageBucket from '@orbit/local-storage-bucket';
import IndexedDBSource, { supportsIndexedDB } from '@orbit/indexeddb';
import IndexedDBBucket from '@orbit/indexeddb-bucket';
import fetch from 'ember-network/fetch';
import Ember from 'ember';

const { get, set, inject } = Ember;

export default Ember.Service.extend({
  // Inject all of the ember-orbit services
  store: inject.service(),
  dataCoordinator: inject.service(),
  dataSchema: inject.service(),
  dataKeyMap: inject.service(),

  mode: null,
  bucket: null,

  availableModes: [
    { id: 'memory-only', description: 'store' },
    { id: 'offline-only', description: 'store + backup' },
    { id: 'pessimistic-server', description: 'store + remote' },
    { id: 'optimistic-server', description: 'store + remote + backup' }
  ],

  init() {
    this._super(...arguments);

    let BucketClass = supportsIndexedDB ? IndexedDBBucket : LocalStorageBucket;
    let bucket = new BucketClass({ namespace: 'peeps-settings' });
    set(this, 'bucket', bucket);
  },

  initialize() {
    let mode = window.localStorage.getItem('peeps-mode') || 'offline-only';
    return this.configure(mode);
  },

  configure(mode) {
    if (mode === get(this, 'mode')) { return; }

    console.log('[orbit-configuration]', 'mode', mode);

    // Instantiate ember-orbit services
    let coordinator = get(this, 'dataCoordinator');
    let store = get(this, 'store');
    let schema = get(this, 'dataSchema');
    let keyMap = get(this, 'dataKeyMap');
    let bucket = get(this, 'bucket');

    return this.clearActiveConfiguration()
      .then(() => {
        set(this, 'mode', mode);
        window.localStorage.setItem('peeps-mode', mode);
        let pessimisticMode = (mode === 'pessimistic-server');

        // Log all events
        coordinator.addStrategy(new EventLoggingStrategy());

        // Truncate logs as possible
        coordinator.addStrategy(new LogTruncationStrategy());

        // Configure a remote source (if necessary)
        if (mode === 'pessimistic-server' ||
            mode === 'optimistic-server') {

          // Use `fetch` implementation from `ember-network`
          Orbit.fetch = fetch;

          let remote = new JSONAPISource({ name: 'remote', bucket, keyMap, schema });
          coordinator.addSource(remote);

          // Sync all remote changes with the store
          coordinator.addStrategy(new SyncStrategy({
            source: 'remote',
            target: 'store',
            blocking: pessimisticMode
          }));

          // Pull query results from the server
          coordinator.addStrategy(new RequestStrategy({
            source: 'store',
            on: 'beforeQuery',

            target: 'remote',
            action: 'pull',

            blocking: pessimisticMode,

            catch(e) {
              console.log('error performing remote.pull', e);
              this.source.requestQueue.skip();
              this.target.requestQueue.skip();

              throw e;
            }
          }));

          // Handle remote push failures differently for optimistic and pessimistic
          // scenarios.
          if (pessimisticMode) {
            // Push update requests to the server.
            coordinator.addStrategy(new RequestStrategy({
              source: 'store',
              on: 'beforeUpdate',

              target: 'remote',
              action: 'push',

              blocking: true,

              catch(e) {
                console.log('error performing remote.push', e);
                this.source.requestQueue.skip();
                this.target.requestQueue.skip();

                throw e;
              }
            }));
          } else {
            // Push update requests to the server.
            coordinator.addStrategy(new RequestStrategy({
              source: 'store',
              on: 'beforeUpdate',

              target: 'remote',
              action: 'push',

              blocking: false
            }));

            coordinator.addStrategy(new RequestStrategy({
              source: 'remote',
              on: 'pushFail',

              action(transform, e) {
                if (e instanceof NetworkError) {
                  // When network errors are encountered, try again in 5s
                  console.log('NetworkError - will try again soon');
                  setTimeout(() => {
                    remote.requestQueue.retry();
                  }, 5000);

                } else {
                  // When non-network errors occur, notify the user and
                  // reset state.
                  let label = transform.options && transform.options.label;
                  if (label) {
                    alert(`Unable to complete "${label}"`);
                  } else {
                    alert(`Unable to complete operation`);
                  }

                  // Roll back store to position before transform
                  if (store.transformLog.contains(transform.id)) {
                    console.log('Rolling back - transform:', transform.id);
                    store.rollback(transform.id, -1);
                  }

                  return remote.requestQueue.skip();
                }
              },

              blocking: true
            }));
          }
        }

        // Configure a backup source
        if (mode === 'offline-only' ||
            mode === 'optimistic-server') {

          let BackupClass = supportsIndexedDB ? IndexedDBSource : LocalStorageSource;
          let backup = new BackupClass({ name: 'backup', namespace: 'peeps', bucket, keyMap, schema });
          coordinator.addSource(backup);

          // Backup all store changes (by making this strategy blocking we ensure that
          // the store can't change without the change also being backed up).
          coordinator.addStrategy(new SyncStrategy({
            source: 'store',
            target: 'backup',
            blocking: true
          }));

          return coordinator.activate()
            .then(() => {
              return backup.pull(oqb.records())
                .then(transform => store.sync(transform))
                .then(() => backup.transformLog.clear())
                .then(() => store.transformLog.clear())
                .then(() => coordinator.activate());
            });

        } else {
          return coordinator.activate();
        }
      });
  },

  clearActiveConfiguration() {
    let coordinator = get(this, 'dataCoordinator');

    if (coordinator.activated) {
      return coordinator.deactivate()
        .then(() => {
          console.log('[orbit-configuration]', 'resetting browser storage');

          // Reset browser storage
          let backup = coordinator.getSource('backup');
          if (backup) {
            return backup.reset();
          } else {
            return Orbit.Promise.resolve();
          }
        })
        .then(() => {
          console.log('[orbit-configuration]', 'resetting sources and strategies');

          // Remove strategies
          coordinator.strategyNames.forEach(name => coordinator.removeStrategy(name));

          // Reset and remove sources (other than the store)
          coordinator.sources.forEach(source => {
            source.transformLog.clear();
            source.requestQueue.clear();
            source.syncQueue.clear();

            if (source.name === 'store') {
              // Keep the store around, but reset its cache
              source.cache.reset();
            } else {
              coordinator.removeSource(source.name);
            }
          });
        });
    } else {
      return Orbit.Promise.resolve();
    }
  }
});

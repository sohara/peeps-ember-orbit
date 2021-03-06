import Ember from 'ember';

export default Ember.Route.extend({
  model(params) {
    return this.store.cache.findRecord('contact', params.contact_id, { label: 'Find contact' });
  },

  afterModel(model) {
    this.transitionTo('contact.index', model);
  }
});

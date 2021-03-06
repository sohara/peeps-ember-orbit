import Ember from 'ember';
import { 
  Model,
  attr,
  hasMany 
} from 'ember-orbit';

export default Model.extend({
  firstName: attr('string'),
  lastName: attr('string'),
  email: attr('string'),
  twitter: attr('string'),
  phoneNumbers: hasMany('phoneNumber', { inverse: 'contact' }),

  fullName: Ember.computed('firstName', 'lastName', function() {
    var firstName = this.get('firstName');
    var lastName = this.get('lastName');

    if (firstName && lastName) {
      return firstName + ' ' + lastName;

    } else if (firstName) {
      return firstName;

    } else if (lastName) {
      return lastName;

    } else {
      return '(No name)';
    }
  })
});

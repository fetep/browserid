/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Mozilla BrowserID.
 *
 * The Initial Developer of the Original Code is Mozilla.
 * Portions created by the Initial Developer are Copyright (C) 2011
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

/*globals steal
 */
window.console = window.console || {
  log: function() {}
};

steal
  .plugins('jquery')
  .then('../lib/jschannel',
        '../lib/base64',
        '../lib/underscore-min',
        '../dialog/resources/channel',
        '../shared/browserid',
        '../shared/storage',
        '../shared/tooltip',
        '../shared/validation',
        '../shared/browserid-extensions',
        '../shared/network',
        '../shared/user',
        '../shared/error-messages',
        '../shared/wait-messages',
        afterResourceLoad);

function afterResourceLoad() {
  $(document).ready(function() {
    var chan = Channel.build({
      window: window.parent,
      origin: "*",
      scope: "mozid_ni"
    });

    var remoteOrigin = undefined;

    function setRemoteOrigin(o) {
      if (!remoteOrigin) {
        remoteOrigin = o;
        BrowserID.User.setOrigin(remoteOrigin);
      }
    }

    chan.bind("getPersistentAssertion", function(trans, params) {
      setRemoteOrigin(trans.origin);

      trans.delayReturn(true);

      BrowserID.User.getPersistentSigninAssertion(function(rv) {
        trans.complete(rv);
      }, function() {
        trans.error();
      });
    });

    chan.bind("logout", function(trans, params) {
      setRemoteOrigin(trans.origin);

      trans.delayReturn(true);

      BrowserID.User.clearPersistentSignin(function(rv) {
        trans.complete(rv);
      }, function() {
        trans.error();
      });
    });
  });
}

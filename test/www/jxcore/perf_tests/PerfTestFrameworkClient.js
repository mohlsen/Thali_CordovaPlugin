/**
 *
 * This is class implementation which is used to load all performance tests from the perf_tests folder
 * Then its expecting start & stop commands for the tests, and also it expects the start command to specify which test
 * file to execute. It also routes the:
 * - 'done' events indicating that the test case has now been finished, and the test now waits teardown to happen with stop command
 * - 'debug' events which are relying some debugging information that could be shown in the applications UI
 */
'use strict';

var fs = require('fs');
var io = require('socket.io-client');
var inherits = require('util').inherits;
var testUtils = require('../lib/testUtils.js');
var EventEmitter = require('events').EventEmitter;

function debug(msg) {
  testUtils.logMessageToScreen(msg);
};

/*
  // A flag used to avoid too frequent Wifi toggling
  var wifiRepairOngoing = false;

  _testServer.on('error', function (data) {

    console.log(data);

    if (wifiRepairOngoing) {
      return;
    }

    wifiRepairOngoing = true;
    // If we have a connection error to the test server, we try to repair
    // the connection by toggling Wifi off and on. This forces devices
    // to re-connect to the Wifi access point.
    if (data.type === 'connect_error') {
      testUtils.toggleWifi(false, function () {
        testUtils.toggleWifi(true, function () {
          console.log('Wifi toggled for connection repair');
          // This is the time when Wifi toggling is completed, but it
          // doesn't necessarily mean that the connection to the Wifi
          // access point is already restored. There is some time
          // needed from turning Wifi on to the point when the connection
          // is functional.
        });
      });
    }

    setTimeout(function () {
      wifiRepairOngoing = false;
    }, 60 * 1000);
  });


  return _testServer;
}
*/

function TestFrameworkClient(deviceName, bluetoothAddress, testServer) {

  TestFrameworkClient.super_.call(this);

  this.deviceName = deviceName;
  this.bluetoothAddress = bluetoothAddress;

  var self = this;

  this.doneCallback = function(data) {
    console.log('done, now sending data to server');
    self.testServer.emit("test data", data);
    self.printResults(data);
  }

  this.tests = {};
  console.log('check test folder');
  fs.readdirSync(__dirname).forEach(function(fileName) {
    if ((fileName.indexOf("test") == 0) &&
      fileName.indexOf(".js", fileName.length - 3) != -1) {
      console.log('found test : ./' + fileName);
      this.tests[fileName] = require('./' + fileName);
    }
  }, this);

  var self = this;

  // Inelegant but this allows me to inject a
  // mock testServer (which we see as simple EventEmitter)

  if (!testServer) {
    var serverOptions = {  
      transports: ['websocket']
    };
    this.testServer = io('http://' + require('../server-address') + ':' + 3000 + '/', serverOptions);
  } else {
    this.testServer = testServer;
  }

  this.testServer.on('too_late', function (data) {
    // We connected too late to take part in a test session
    // signal to CI (via stdout) that we're quitting (and do so)
    console.log("****TEST TOOK:  ms ****" );
    console.log("****TEST_LOGGER:[PROCESS_ON_EXIT_FAILED]****");
    process.exit(0);
  });

  this.testServer.on('connect', function () {

    console.log('Connected to the server!');
    testUtils.logMessageToScreen('Connected to the server');

    // Inform the test server who we are, what type of test we're prepared to run
    // and what our bluetoothAddress is (Android only)

    var platform;
    if (jxcore.utils.OSInfo().isAndroid) {
      platform = 'android';
    } else {
      platform = 'ios';
    }

    this.testServer.emit('present', JSON.stringify({
      "os" : platform,
      "name": self.deviceName,
      "type": "perftests",
      "tests": Object.keys(self.tests)
    }));
  });

  this.testServer.on('start', function(testData) {

    debug("--- start :" + testData.testName + "---");
    if (!(testData.testName in self.tests)) {
      self.testServer.emit("error", "Unknown test");
      return;
    }

    self.currentTest = new self.tests[testData.testName] (
      testData.testData,
      self.deviceName,
      shuffle(testData.addressList)
    );

    self.setCallbacks(self.currentTest);
    self.currentTest.start();
  });

  this.testServer.on('stop', function() {
    debug("stop");
    self.stopAllTests(false);
  });

  this.testServer.on('timeout', function() {
   debug("stop-by-timeout");
   self.stopAllTests(true);
  });

  this.testServer.on('end', function() {
    console.log("****TEST TOOK:  ms ****" );
    console.log("****TEST_LOGGER:[PROCESS_ON_EXIT_SUCCESS]****");
    self.stopAllTests(true);
    self.testServer.close();
  });

  this.testServer.on('closed', function() {
    console.log('The server connection has closed.');

    //we need to stop & close any tests we are running here
    TestFramework.stopAllTests(false);
    testUtils.logMessageToScreen('fully-closed');
    console.log('turning Radios off');
    testUtils.toggleRadios(false);
  });
}

inherits(TestFrameworkClient, EventEmitter);

// the Fisher-Yates (aka Knuth) Shuffle.
// http://stackoverflow.com/questions/2450954/how-to-randomize-shuffle-a-javascript-array
function shuffle(array) {
  var currentIndex = array.length, temporaryValue, randomIndex;

  // While there remain elements to shuffle...
  while (0 !== currentIndex) {

    // Pick a remaining element...
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex -= 1;

    // And swap it with the current element.
    temporaryValue = array[currentIndex];
    array[currentIndex] = array[randomIndex];
    array[randomIndex] = temporaryValue;
  }

  return array;
}

TestFrameworkClient.prototype.setCallbacks = function(test) {
  test.on('done', this.doneCallback);
}

TestFrameworkClient.prototype.stopAllTests = function(doReport) {
  console.log('stop tests now !');
  console.log('stop current!');
  this.currentTest.stop(doReport);
  this.currentTest.removeListener('done', this.doneCallback);
  this.currentTest = null;
}

// Everything below here is report printing
//////////////////////////////////////////////////////////////////

TestFrameworkClient.prototype.printResults = function(data) {

  console.log("-- RESULT DATA " + data);
  var jsonData = JSON.parse(data);

  var compareTime = function (a, b) {
    if (a.time < b.time)
      return -1;
    if (a.time > b.time)
      return 1;
    return 0;
  }

  if (jsonData) {

    var results = {};

    if (jsonData.peersList) {
      this.printResultLine('peersList',jsonData.peersList);
      this.printMinMaxLine(jsonData.peersList);
    } else if (jsonData.connectList) {
      results.connectList = [];
      results.connectError = {};
      this.preProcessResults(jsonData.connectList, results.connectList, results.connectError);
    } else if (jsonData.sendList) {
      results.sendList = [];
      results.sendError = {};
      this.preProcessResults(jsonData.sendList, results.sendList, results.sendError);
    } else {
      console.log('has unknown data : ' + data);
    }

    if (results.connectList) { // && (results[devName].connectList.length > 0)) {
      results.connectList.sort(compareTime);

      this.printResultLine('connectList',results.connectList);
      this.printMinMaxLine(results.connectList);

      if (results.connectError) {
        this.printFailedLine(
          'connectList',
          results.connectError.failedPeer, 
          results.connectError.notTriedList, 
          results.connectList.length
        );
      }

      } else if (results.connectError && results.connectError.failedPeer > 0) {
        console.log(
          "All (" + results.connectError.failedPeer + ") Re-Connect test connections failed"
        );
      }

      if (results.sendList) { // && (results[devName].sendList.length > 0)) {
        results.sendList.sort(compareTime);

        this.printResultLine('sendList',results.sendList);
        this.printMinMaxLine(results.sendList);

        if (results.sendError) {
          this.printFailedLine(
            'sendList',
            results.sendError.failedPeer, 
            results.sendError.notTriedList, 
            results.sendList.length
          );
        }
    } else if (results.sendError && results.sendError.failedPeer > 0) {
      console.log("All (" + results.sendError.failedPeer + ") SendData test connections failed");
    }
  }
}

TestFrameworkClient.prototype.printFailedLine = function(
  what, failedPeers, notTriedPeers, successCount
) {
  if (!notTriedPeers || !failedPeers ||  (failedPeers.length + successCount) <=0){
      return;
  }

  console.log(
    what + " failed peers count : " + failedPeers.length + 
    " [" + ((failedPeers.length * 100) / (successCount + failedPeers.length)) + " %]"
  );

  failedPeers.forEach(function(peer) {
    console.log("- Peer ID : " + peer.name + ", Tried : " + peer.connections);
  });

  console.log(
    what + " never tried peers count : " + notTriedPeers.length + 
    " [" + ((notTriedPeers.length * 100) / (successCount + failedPeers.length + 
    notTriedPeers.length)) + " %]"
  );

  notTriedPeers.forEach(function(peer) {
    console.log("- Peer ID : " + peer.name);
  });
}

TestFrameworkClient.prototype.printMinMaxLine  = function(list) {
  if (!list || list.length <= 0){
    console.log('Results list does not contain any items');
    return;
  }
  console.log(
    'Result count ' + list.length + ', range ' + list[0].time + ' ms to  ' + 
    list[(list.length - 1)].time + " ms."
  );
}

TestFrameworkClient.prototype.printResultLine  = function(what, list) {

  var percentile  = function(array, percentile) {
    var index = Math.round(array.length * percentile);
    if (index > 0){
      index = index - 1;
    }
    if (index < array.length) {
      return array[index].time;
    }
  }

  console.log(
    what + " : 100% : " + percentile(list, 1.00) + " ms, 99% : " + 
    percentile(list, 0.99)  + " ms, 95 : " + percentile(list, 0.95) + " ms, 90% : " + 
    percentile(list, 0.90) + " ms."
  );
}

TestFrameworkClient.prototype.preProcessResults  = function(source, target, errorTarget){

  if (!target) {
    target = [];
  }

  if (!errorTarget.failedPeer) {
    errorTarget.failedPeer = [];
  }

  if (!errorTarget.notTriedList) {
    errorTarget.notTriedList = [];
  }

  source.forEach(function(roundResult) {

    if (!roundResult || roundResult == null){
      return;
    }

    if (roundResult.result == "OK") {
      target.push(roundResult);
    } else if (roundResult.connections){
      errorTarget.failedPeer.push(roundResult);
    } else { // if connections is zero, then we never got to try to connect before we got timeout
      errorTarget.notTriedList.push(roundResult);
    }
  });
}

module.exports = TestFrameworkClient;

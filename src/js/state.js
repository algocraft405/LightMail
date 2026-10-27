'use strict';

var api = window.smartMail;
var COLORS = [
  ['blue', '#0f6cbd'],
  ['red', '#d13438'],
  ['green', '#0b6a0b'],
  ['orange', '#ca5010'],
  ['purple', '#5c2e91'],
  ['yellow', '#986f0b'],
  ['teal', '#038387'],
  ['pink', '#c239b3'],
];

var state = {
  settings: null,
  accounts: [],
  accountId: null,
  folderId: null,
  folders: [],
  tags: [],
  messages: [],
  nextPage: null,
  selected: new Set(),
  anchorId: null,
  activeId: null,
  active: null,
  tagFilter: null,
  query: '',
  loadingList: false,
  loadingMessage: false,
  collapsed: new Set(),
  newMailAccountId: null,
  unreadPages: {},
  navWidth: 268,
  listWidth: 392,
  modal: null,
  compose: null,
  confirmResolve: null,
  tagColor: 'blue',
  listGen: 0,
  accountGen: 0,
  msgGen: 0,
  searchTimer: null,
  menu: null,
  module: 'mail',
  mailMode: 'original',
  favoriteFolders: new Set(),
  calView: 'month',
  cursor: new Date(),
  selectedDay: new Date(),
  calendars: [],
  events: [],
  hiddenCalendars: new Set(),
  hiddenCalAccounts: new Set(),
  seenCalAccounts: new Set(),
  calQuery: '',
  calKey: '',
  calAccountId: null,
  calError: '',
  calLoading: false,
  calScrollReset: true,
  nowTimer: null,
  pollSeconds: 60,
  pollTimer: null,
  pollBusy: false,
  lastPollAt: 0,
  updatedAt: 0,
  heldUnread: null,
  justRead: new Set(),
  heldTail: [],
  heldNext: null,
};

var listCache = new Map();
var messageCache = new Map();
var folderCache = new Map();
var calStores = new Map();
var progressCount = 0;
var drag = null;
var skipClick = false;
var toastTimer = null;
var badgesReady = false;
var POLL_CHOICES = [30, 60, 120, 300];
var AHEAD_PAGES = 0;
var SCROLL_PAGES = 1;
var RUNWAY_PX = 1400;
var FIRST_BATCH = 90;

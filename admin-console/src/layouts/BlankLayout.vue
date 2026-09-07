<template>
  <!--
    A layout with no header, drawer or footer, for pages shown before sign-in.

    It exists because QPage must be a deep child of a QLayout — Quasar throws
    "QPage needs to be a deep child of QLayout" and the app fails to mount
    otherwise. Rendering the login page bare would work only if it avoided QPage
    entirely, which would also give up QPage's viewport sizing.

    Any future pre-auth page (password reset, an error screen) belongs here too,
    rather than each one wrapping itself.
  -->
  <q-layout view="lHh Lpr lFf">
    <q-page-container>
      <router-view />
    </q-page-container>
  </q-layout>
</template>

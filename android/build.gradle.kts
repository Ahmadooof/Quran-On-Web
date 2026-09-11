/* Matched to the toolchain Android Studio brought with it — Gradle 9.3 on a
   JDK 25 runtime. AGP 8.5 was written for Gradle 8 and JDK 17-21: debug builds
   staggered through it, and lint went down on a release build with nothing but
   a version number for an error message.

   The last of the 8s rather than a 9: AGP 9 has Kotlin support of its own and
   refuses the Kotlin Android plugin beside it, which is a different project
   layout for no gain here. */
plugins {
    id("com.android.application") version "9.4.0" apply false
    id("org.jetbrains.kotlin.android") version "2.2.10" apply false
}

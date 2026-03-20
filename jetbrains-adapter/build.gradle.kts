plugins {
    id("org.jetbrains.intellij") version "1.17.4"
    kotlin("jvm") version "1.9.25"
}

group = "cn.xiaoo.smartime"
version = ((findProperty("pluginVersion") as String?)
    ?: System.getenv("SMARTIME_PLUGIN_VERSION")
    ?: "0.0.3")
    .removePrefix("v")
    .removePrefix("V")

repositories {
    mavenCentral()
}

intellij {
    version.set("2021.1")
    type.set("IC")
}

dependencies {
    implementation(kotlin("stdlib"))
}

tasks {
    patchPluginXml {
        sinceBuild.set("211")
        untilBuild.set("999.*")
        pluginDescription.set(
            """
            SmartIME JetBrains Adapter.
            Unified input method switching for IntelliJ Platform IDEs.
            Uses Go worker for IME detection and switching.
            Compatible range: IntelliJ Platform 2021.1+ (build 211+).
            """.trimIndent(),
        )
    }

    withType<JavaCompile> {
        sourceCompatibility = "11"
        targetCompatibility = "11"
        options.encoding = "UTF-8"
    }

    withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> {
        kotlinOptions.jvmTarget = "11"
    }

    processResources {
        val candidates = listOf(
            projectDir.parentFile.resolve("tools/ime-worker.exe"),
            rootProject.projectDir.resolve("tools/ime-worker.exe"),
            projectDir.resolve("tools/ime-worker.exe"),
        )
        val worker = candidates.firstOrNull { it.exists() }
        if (worker != null) {
            from(worker) {
                into("bin")
                rename { "ime-worker.exe" }
            }
        }
    }
}
